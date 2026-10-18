// GitHub Actions 定时执行：从 GitHub 的机器（不是 Cloudflare 的 IP）抓所有机场订阅，
// 写进 Worker 的 KV 当缓存。机场屏蔽 Cloudflare 时，Worker 就改用这份缓存。
// 日志只印数量，不印订阅链接与内容。
import { parseSubscription } from '../src/parse.js';
import { cacheKey, CACHE_TTL_SECONDS } from '../src/cache.js';

const API = 'https://api.cloudflare.com/client/v4';
const FETCH_UA = 'clash.meta';
const FETCH_TIMEOUT_MS = 20000;
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID } = process.env;

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`Cloudflare API ${res.status}：${(await res.text()).slice(0, 300)}`);
  return res;
}

async function only(path, what, pick = () => true) {
  const { result } = await (await cf(path)).json();
  const matches = result.filter(pick);
  if (matches.length !== 1) throw new Error(`找到 ${matches.length} 个${what}，请在 Secrets 里直接指定`);
  return matches[0].id;
}

async function listRecords(accountId, nsId) {
  const keys = [];
  let cursor = '';
  do {
    const { result, result_info } = await (
      await cf(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/keys?prefix=sub:&limit=1000${cursor ? `&cursor=${cursor}` : ''}`)
    ).json();
    keys.push(...result.map((k) => k.name));
    cursor = result_info?.cursor || '';
  } while (cursor);
  return Promise.all(
    keys.map(async (k) => (await cf(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(k)}`)).json()),
  );
}

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
  if (!TOKEN) {
    console.log('::notice::没有设置 CLOUDFLARE_API_TOKEN，跳过代抓（设置方法见 README）');
    return;
  }
  const accountId = CLOUDFLARE_ACCOUNT_ID || (await only('/accounts', ' Cloudflare 账号（CLOUDFLARE_ACCOUNT_ID）'));
  const nsId =
    KV_NAMESPACE_ID ||
    (await only(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`, '订阅 KV（KV_NAMESPACE_ID）', (ns) => /sub[-_]store/i.test(ns.title)));

  const records = await listRecords(accountId, nsId);
  const urls = [...new Set(records.flatMap((r) => (r.sources ?? []).map((s) => s.url)))];
  const fetched = await Promise.all(urls.map(async (url) => ({ url, data: await fetchSource(url) })));
  const ok = fetched.filter((f) => f.data);
  const entries = await Promise.all(
    ok.map(async ({ url, data }) => ({ key: await cacheKey(url), value: JSON.stringify(data), expiration_ttl: CACHE_TTL_SECONDS })),
  );
  if (entries.length) {
    await cf(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/bulk`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entries),
    });
  }
  console.log(`${records.length} 个合并订阅、${urls.length} 个机场：缓存成功 ${ok.length}，失败 ${urls.length - ok.length}`);
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
