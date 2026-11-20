// GitHub Actions 的脚本（refresh-cache.mjs、classify.mjs）用 Cloudflare API 读写 Worker 的 KV。
// CLOUDFLARE_ACCOUNT_ID、KV_NAMESPACE_ID 没设时自动找（账号只有一个、名称含 sub-store 的 KV 只有一个才行）
const API = 'https://api.cloudflare.com/client/v4';
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID } = process.env;

export const hasToken = Boolean(TOKEN);

export async function cf(path, init = {}) {
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

export async function accountId() {
  return CLOUDFLARE_ACCOUNT_ID || only('/accounts', ' Cloudflare 账号（CLOUDFLARE_ACCOUNT_ID）');
}

/** 订阅 KV 的读写入口：{ accountId, records(), put(entries) } */
export async function openKv() {
  const account = await accountId();
  const nsId =
    KV_NAMESPACE_ID ||
    (await only(`/accounts/${account}/storage/kv/namespaces?per_page=100`, '订阅 KV（KV_NAMESPACE_ID）', (ns) => /sub[-_]store/i.test(ns.title)));
  const base = `/accounts/${account}/storage/kv/namespaces/${nsId}`;
  return {
    accountId: account,
    /** 所有合并订阅：[{ token, record }] */
    async records() {
      const keys = [];
      let cursor = '';
      do {
        const { result, result_info } = await (await cf(`${base}/keys?prefix=sub:&limit=1000${cursor ? `&cursor=${cursor}` : ''}`)).json();
        keys.push(...result.map((k) => k.name));
        cursor = result_info?.cursor || '';
      } while (cursor);
      return Promise.all(
        keys.map(async (k) => ({ token: k.slice('sub:'.length), record: await (await cf(`${base}/values/${encodeURIComponent(k)}`)).json() })),
      );
    },
    /** 一次写多个键：[{ key, value, expiration_ttl }] */
    async put(entries) {
      if (!entries.length) return;
      await cf(`${base}/bulk`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entries),
      });
    },
  };
}
