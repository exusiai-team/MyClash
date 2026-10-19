import { parseSubscription, mergeSubscriptions, sumUserinfo, dumpConfig, detectAirportName } from './parse.js';
import { cacheKey } from './cache.js';
import { UPSTREAM_SCRIPT_URL, patchScript } from './script.js';

const KEY_PREFIX = 'sub:';
const FETCH_TIMEOUT_MS = 15000;
const FETCH_UA = 'clash.meta';
const MAX_SOURCES = 30;
// 管理页「立即刷新缓存」：触发 GitHub Actions 的代抓 workflow
const REFRESH_WORKFLOW = 'refresh-cache.yml';
const REFRESH_COOLDOWN_KEY = 'refresh:cooldown';
const REFRESH_COOLDOWN_SECONDS = 60;
// 节点前缀：name = 机场名称（自定义 > 自动识别），index = S1、S2…（自定义 > 序号），none = 不加
const PREFIX_MODES = ['name', 'index', 'none'];
const SCRIPT_CACHE_SECONDS = 3600;
// 管理页一次查多个 TOKEN 的上限
const MAX_LOOKUP = 50;
// 同一个 isolate 内重复使用修补后的脚本，1 小时内不再向 GitHub 抓
let scriptCache = null;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      return json({ error: err.expose ? err.message : '服务器错误' }, err.status ?? 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // 覆写脚本不需要 KV，预览版本也能用
  if (parts[0] === 'script.js' && parts.length === 1 && request.method === 'GET') return serveScript();
  if (!env.SUB_STORE) return text('这个版本没有绑定 KV（预览版本），请使用正式的 Worker 地址', 503);

  if (parts.length === 0) return text('MyClash 订阅合并 Worker 运行中。合并订阅链接：/sub/<TOKEN>\n');
  if (parts[0] === 'sub' && parts.length === 2 && request.method === 'GET') return serveSubscription(env, parts[1]);
  if (parts[0] === 'api') return api(request, env, parts.slice(1));
  return json({ error: '找不到' }, 404);
}

// --- 订阅输出 ---

async function serveSubscription(env, token) {
  const record = /^[a-f0-9]{32}$/.test(token) ? await env.SUB_STORE.get(KEY_PREFIX + token, 'json') : null;
  if (!record) return text('找不到这个 TOKEN（可能已删除或已更换）', 404);

  const mode = record.prefixMode ?? 'index';
  const results = await Promise.all(record.sources.map((source, i) => fetchSource(env, source, i, mode)));
  const ok = results.filter((r) => r.parsed && r.parsed.proxies.length > 0);
  if (ok.length === 0) return text('所有机场订阅都抓取失败或没有节点，请稍后再试', 502);

  const config = mergeSubscriptions(
    ok.map((r) => ({ prefix: r.prefix, parsed: r.parsed })),
    { rateTag: record.rateTag === true },
  );
  const comments = [
    `MyClash 合并订阅：${record.name}`,
    `更新时间：${new Date().toISOString()}`,
    ...results.map((r) =>
      r.parsed
        ? `[${r.label}] ${r.parsed.proxies.length} 个节点${r.parsed.skipped ? `（${r.parsed.skipped} 个无法解析已略过）` : ''}` +
          (r.cachedAt ? `（直连失败：${r.directError}，使用 ${cacheAge(r.cachedAt)}的缓存）` : '')
        : `[${r.label}] 失败：${r.error}`,
    ),
  ];

  const headers = {
    'Content-Type': 'text/yaml; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    'Profile-Update-Interval': '12',
    'Cache-Control': 'no-store',
  };
  const userinfo = sumUserinfo(ok.map((r) => r.userinfo));
  if (userinfo) headers['Subscription-Userinfo'] = userinfo;

  return new Response(dumpConfig(config, comments), { headers });
}

// --- 覆写脚本（上游 MyClash 脚本 + 本项目的修补） ---

async function serveScript() {
  if (!scriptCache || Date.now() - scriptCache.at > SCRIPT_CACHE_SECONDS * 1000) {
    const body = await fetchScript();
    if (body) scriptCache = { body, at: Date.now() };
    // 抓不到时沿用旧的脚本，总比让客户端更新失败好
    else if (!scriptCache) return text('抓取上游 MyClash 脚本失败，请稍后再试', 502);
  }
  return new Response(scriptCache.body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': `public, max-age=${SCRIPT_CACHE_SECONDS}`,
    },
  });
}

async function fetchScript() {
  try {
    const res = await fetch(UPSTREAM_SCRIPT_URL, {
      cf: { cacheTtl: SCRIPT_CACHE_SECONDS, cacheEverything: true },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok ? patchScript(await res.text()) : null;
  } catch {
    return null;
  }
}

async function fetchSource(env, source, index, mode) {
  const fallback = source.name || `S${index + 1}`;
  let label = fallback;
  let prefix = mode === 'none' ? '' : fallback;
  let got = await fetchUpstream(source.url);
  if (got.error) {
    // 直连失败就改用 GitHub Actions 代抓的缓存
    const cached = await env.SUB_STORE.get(await cacheKey(source.url), 'json').catch(() => null);
    if (cached?.body) got = { ...cached, cachedAt: cached.fetchedAt, directError: got.error };
  }
  if (!source.name) {
    const detected = detectAirportName(got.disposition, source.url);
    if (detected) {
      label = detected;
      if (mode === 'name') prefix = detected;
    }
  }
  if (got.error) return { label, prefix, error: got.error };
  const parsed = parseSubscription(got.body);
  if (parsed.proxies.length === 0) return { label, prefix, parsed, error: '没有可用节点' };
  return { label, prefix, parsed, userinfo: got.userinfo, cachedAt: got.cachedAt, directError: got.directError };
}

async function fetchUpstream(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const disposition = res.headers.get('content-disposition');
    if (!res.ok) return { disposition, error: `HTTP ${res.status}` };
    return { disposition, userinfo: res.headers.get('subscription-userinfo'), body: await res.text() };
  } catch (err) {
    return { error: err?.name === 'TimeoutError' ? '超时' : '连接失败' };
  }
}

function cacheAge(ms) {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
}

// --- 管理 API ---

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

async function api(request, env, parts) {
  const { method } = request;
  if (parts[0] !== 'subs') throw new HttpError(404, '找不到');

  if (parts.length === 1) {
    if (method === 'POST') {
      const input = validate(await readJson(request));
      const now = Date.now();
      const record = { ...input, createdAt: now, updatedAt: now };
      const token = newToken();
      await putRecord(env, token, record);
      return json({ token, ...record }, 201);
    }
  }

  // 管理页一次查完自己记得的 TOKEN；只查调用者给的，不提供列出全部订阅
  if (parts.length === 2 && parts[1] === 'lookup' && method === 'POST') {
    const { tokens } = (await readJson(request)) ?? {};
    if (!Array.isArray(tokens)) throw new HttpError(400, 'tokens 必须是数组');
    if (tokens.length > MAX_LOOKUP) throw new HttpError(400, `一次最多查 ${MAX_LOOKUP} 个 TOKEN`);
    const valid = [...new Set(tokens)].filter((t) => /^[a-f0-9]{32}$/.test(t));
    const records = await Promise.all(valid.map((t) => env.SUB_STORE.get(KEY_PREFIX + t, 'json')));
    return json({ items: valid.flatMap((t, i) => (records[i] ? [{ token: t, ...records[i] }] : [])) });
  }

  const token = parts[1];
  if (!/^[a-f0-9]{32}$/.test(token ?? '')) throw new HttpError(404, '找不到这个 TOKEN');
  const record = await env.SUB_STORE.get(KEY_PREFIX + token, 'json');
  if (!record) throw new HttpError(404, '找不到这个 TOKEN');

  if (parts.length === 2) {
    if (method === 'GET') return json({ token, ...record });
    if (method === 'PUT') {
      const updated = { ...record, ...validate(await readJson(request)), updatedAt: Date.now() };
      await putRecord(env, token, updated);
      return json({ token, ...updated });
    }
    if (method === 'DELETE') {
      await env.SUB_STORE.delete(KEY_PREFIX + token);
      return json({ ok: true });
    }
  }

  if (parts.length === 3 && parts[2] === 'refresh' && method === 'POST') return triggerRefresh(env);

  if (parts.length === 3 && parts[2] === 'rotate' && method === 'POST') {
    const next = newToken();
    const updated = { ...record, updatedAt: Date.now() };
    await putRecord(env, next, updated);
    await env.SUB_STORE.delete(KEY_PREFIX + token);
    return json({ token: next, ...updated });
  }

  throw new HttpError(405, '不支持的操作');
}

async function triggerRefresh(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    throw new HttpError(501, '还没设置 GITHUB_TOKEN，无法从管理页刷新缓存（设置方法见 README）');
  }
  if (await env.SUB_STORE.get(REFRESH_COOLDOWN_KEY)) throw new HttpError(429, '刚刷新过，请 1 分钟后再试');
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${REFRESH_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'myclash-worker',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) throw new HttpError(502, `触发 GitHub Actions 失败：HTTP ${res.status}（检查 GITHUB_TOKEN 的权限）`);
  await env.SUB_STORE.put(REFRESH_COOLDOWN_KEY, '1', { expirationTtl: REFRESH_COOLDOWN_SECONDS });
  return json({ ok: true });
}

function putRecord(env, token, record) {
  return env.SUB_STORE.put(KEY_PREFIX + token, JSON.stringify(record));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, '内容不是有效的 JSON');
  }
}

function validate(input) {
  const name = String(input?.name ?? '').trim();
  if (!name || name.length > 60) throw new HttpError(400, '名称必填，且不能超过 60 字');
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new HttpError(400, '至少要有一个机场订阅');
  }
  if (input.sources.length > MAX_SOURCES) throw new HttpError(400, `最多 ${MAX_SOURCES} 个机场订阅`);

  const sources = input.sources.map((s, i) => {
    const url = String(s?.url ?? '').trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, `第 ${i + 1} 个订阅链接格式错误`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new HttpError(400, `第 ${i + 1} 个订阅链接必须是 http(s)`);
    }
    const sourceName = String(s?.name ?? '').trim().slice(0, 20);
    return { name: sourceName, url };
  });
  const prefixMode = PREFIX_MODES.includes(input.prefixMode) ? input.prefixMode : 'name';
  return { name, prefixMode, rateTag: input.rateTag === true, sources };
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'},
  });
}
