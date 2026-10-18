import { parseSubscription, mergeSubscriptions, sumUserinfo, dumpConfig } from './parse.js';

const KEY_PREFIX = 'sub:';
const FETCH_TIMEOUT_MS = 15000;
const FETCH_UA = 'clash.meta';
const MAX_SOURCES = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Expose-Headers': 'Subscription-Userinfo, Content-Disposition',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      return await route(request, env);
    } catch (err) {
      return json({ error: err.expose ? err.message : '伺服器錯誤' }, err.status ?? 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 0) return text('MyClash 訂閱合併 Worker 運作中。合併訂閱網址：/sub/<TOKEN>\n');
  if (parts[0] === 'sub' && parts.length === 2 && request.method === 'GET') return serveSubscription(env, parts[1]);
  if (parts[0] === 'api') {
    await requireAdmin(request, env);
    return api(request, env, parts.slice(1));
  }
  return json({ error: '找不到' }, 404);
}

// --- 訂閱輸出 ---

async function serveSubscription(env, token) {
  const record = /^[a-f0-9]{32}$/.test(token) ? await env.SUBS.get(KEY_PREFIX + token, 'json') : null;
  if (!record) return text('找不到這個 TOKEN（可能已刪除或已更換）', 404);

  const results = await Promise.all(record.sources.map((source, i) => fetchSource(source, i)));
  const ok = results.filter((r) => r.parsed && r.parsed.proxies.length > 0);
  if (ok.length === 0) return text('所有機場訂閱都抓取失敗或沒有節點，請稍後再試', 502);

  const config = mergeSubscriptions(ok.map((r) => ({ prefix: r.prefix, parsed: r.parsed })));
  const comments = [
    `MyClash 合併訂閱：${record.name}`,
    `更新時間：${new Date().toISOString()}`,
    ...results.map((r) =>
      r.parsed
        ? `[${r.prefix}] ${r.parsed.proxies.length} 個節點${r.parsed.skipped ? `（${r.parsed.skipped} 個無法解析已略過）` : ''}`
        : `[${r.prefix}] 失敗：${r.error}`,
    ),
  ];

  const headers = {
    'Content-Type': 'text/yaml; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    'Profile-Update-Interval': '12',
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  };
  const userinfo = sumUserinfo(ok.map((r) => r.userinfo));
  if (userinfo) headers['Subscription-Userinfo'] = userinfo;

  return new Response(dumpConfig(config, comments), { headers });
}

async function fetchSource(source, index) {
  const prefix = source.name || `S${index + 1}`;
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': FETCH_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { prefix, error: `HTTP ${res.status}` };
    const parsed = parseSubscription(await res.text());
    if (parsed.proxies.length === 0) return { prefix, parsed, error: '沒有可用節點' };
    return { prefix, parsed, userinfo: res.headers.get('subscription-userinfo') };
  } catch (err) {
    return { prefix, error: err?.name === 'TimeoutError' ? '逾時' : '連線失敗' };
  }
}

// --- 管理 API ---

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    throw new HttpError(503, '尚未設定 ADMIN_PASSWORD，請到 Cloudflare Worker 的「設定 → 變數和機密」新增');
  }
  const auth = request.headers.get('Authorization') ?? '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await safeEqual(given, env.ADMIN_PASSWORD))) throw new HttpError(401, '管理密碼錯誤');
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function api(request, env, parts) {
  const { method } = request;
  if (parts[0] === 'ping' && parts.length === 1) return json({ ok: true });
  if (parts[0] !== 'subs') throw new HttpError(404, '找不到');

  if (parts.length === 1) {
    if (method === 'GET') return json({ items: await listRecords(env) });
    if (method === 'POST') {
      const input = validate(await readJson(request));
      const now = Date.now();
      const record = { ...input, createdAt: now, updatedAt: now };
      const token = newToken();
      await putRecord(env, token, record);
      return json({ token, ...record }, 201);
    }
  }

  const token = parts[1];
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) throw new HttpError(404, '找不到這個 TOKEN');
  const record = await env.SUBS.get(KEY_PREFIX + token, 'json');
  if (!record) throw new HttpError(404, '找不到這個 TOKEN');

  if (parts.length === 2) {
    if (method === 'GET') return json({ token, ...record });
    if (method === 'PUT') {
      const updated = { ...record, ...validate(await readJson(request)), updatedAt: Date.now() };
      await putRecord(env, token, updated);
      return json({ token, ...updated });
    }
    if (method === 'DELETE') {
      await env.SUBS.delete(KEY_PREFIX + token);
      return json({ ok: true });
    }
  }

  if (parts.length === 3 && parts[2] === 'rotate' && method === 'POST') {
    const next = newToken();
    const updated = { ...record, updatedAt: Date.now() };
    await putRecord(env, next, updated);
    await env.SUBS.delete(KEY_PREFIX + token);
    return json({ token: next, ...updated });
  }

  throw new HttpError(405, '不支援的操作');
}

async function listRecords(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: KEY_PREFIX, cursor });
    for (const key of page.keys) {
      items.push({ token: key.name.slice(KEY_PREFIX.length), ...(key.metadata ?? {}) });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function putRecord(env, token, record) {
  const metadata = {
    name: record.name,
    count: record.sources.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return env.SUBS.put(KEY_PREFIX + token, JSON.stringify(record), { metadata });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '內容不是有效的 JSON');
  }
}

function validate(input) {
  const name = String(input?.name ?? '').trim();
  if (!name || name.length > 60) throw new HttpError(400, '名稱必填，且不能超過 60 字');
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new HttpError(400, '至少要有一個機場訂閱');
  }
  if (input.sources.length > MAX_SOURCES) throw new HttpError(400, `最多 ${MAX_SOURCES} 個機場訂閱`);

  const sources = input.sources.map((s, i) => {
    const url = String(s?.url ?? '').trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, `第 ${i + 1} 個訂閱網址格式錯誤`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new HttpError(400, `第 ${i + 1} 個訂閱網址必須是 http(s)`);
    }
    const sourceName = String(s?.name ?? '').trim().slice(0, 20);
    return { name: sourceName, url };
  });
  return { name, sources };
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}
