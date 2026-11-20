// GitHub Actions 定时执行：从 GitHub 的机器（不是 Cloudflare 的 IP）抓所有机场订阅，
// 写进 Worker 的 KV 缓存（跟 Worker 抓成功时写回的是同一份）。屏蔽 Cloudflare 的机场只靠这里更新。
// 日志只印数量，不印订阅链接与内容。
import { parseSubscription } from '../src/parse.js';
import { cacheKey, CACHE_TTL_SECONDS } from '../src/cache.js';
import { hasToken, openKv } from './cloudflare.mjs';

const FETCH_UA = 'clash.meta';
const FETCH_TIMEOUT_MS = 20000;

async function fetchSource(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FETCH_UA }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.text();
    // 只缓存真的解析得出节点的内容，避免把错误页存进去
    if (parseSubscription(body).proxies.length === 0) return null;
    return {
      body,
      disposition: res.headers.get('content-disposition'),
      userinfo: res.headers.get('subscription-userinfo'),
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function main() {
  if (!hasToken) {
    console.log('::notice::没有设置 CLOUDFLARE_API_TOKEN，跳过代抓（设置方法见 README）');
    return;
  }
  const kv = await openKv();
  const records = (await kv.records()).map((r) => r.record);
  const urls = [...new Set(records.flatMap((r) => (r.sources ?? []).map((s) => s.url)))];
  const fetched = await Promise.all(urls.map(async (url) => ({ url, data: await fetchSource(url) })));
  const ok = fetched.filter((f) => f.data);
  const entries = await Promise.all(
    ok.map(async ({ url, data }) => ({ key: await cacheKey(url), value: JSON.stringify(data), expiration_ttl: CACHE_TTL_SECONDS })),
  );
  await kv.put(entries);
  console.log(`${records.length} 个合并订阅、${urls.length} 个机场：缓存成功 ${ok.length}，失败 ${urls.length - ok.length}`);
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
