import { parseSubscription, mergeSubscriptions, filterProxies, extractRate, sumUserinfo, parseUserinfo, isExpired, isExhausted, dumpConfig, detectAirportName } from './parse.js';
import { cacheKey, CACHE_TTL_SECONDS } from './cache.js';
import liteScript from './overrides/lite.js';
import fullScript from './overrides/full.js';

const KEY_PREFIX = 'sub:';
const FETCH_TIMEOUT_MS = 10000;
const FETCH_UA = 'clash.meta';
// 机场订阅缓存（见 loadSource）：30 分钟内的直接用；更旧的先连机场，最多等 2.5 秒，等不到就先用旧缓存
const FRESH_MS = 30 * 60 * 1000;
const STALE_WAIT_MS = 2500;
// 抓不到又没有缓存的机场记在 Worker 的内存里（不写 KV），5 分钟内不再重抓
const FAILURE_MS = 5 * 60 * 1000;
const recentFailures = new Map();
const MAX_SOURCES = 30;
// 管理页「立即刷新缓存」：触发 GitHub Actions 的代抓 workflow
const REFRESH_WORKFLOW = 'refresh-cache.yml';
const REFRESH_COOLDOWN_KEY = 'refresh:cooldown';
const REFRESH_COOLDOWN_SECONDS = 60;
// 管理页显示「同步上游覆写脚本」的最近一次执行与覆写脚本的最后更新时间；结果在 KV 存 5 分钟，少打 GitHub API
const SYNC_WORKFLOW = 'sync-scripts.yml';
const SYNC_STATUS_KEY = 'sync:status';
const SYNC_STATUS_TTL = 300;
const SYNC_COOLDOWN_KEY = 'sync:cooldown';
const SYNC_COOLDOWN_SECONDS = 600;
// 节点前缀：name = 机场名称（自定义 > 自动识别），index = S1、S2…（自定义 > 序号），none = 不加
const PREFIX_MODES = ['name', 'index', 'none'];
// 管理页一次查多个 TOKEN 的上限
const MAX_LOOKUP = 50;
// 每个机场最多手动排除几个节点、节点名称最长几个字
const MAX_EXCLUDE = 2000;
const MAX_NODE_NAME = 200;
// /sub/<TOKEN>?script=lite|full：在服务端套用覆写脚本，客户端不用再加脚本覆写；不带参数则不覆写
const OVERRIDES = {
  lite: { run: liteScript, label: '精简' },
  full: { run: fullScript, label: '全量' },
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      return json({ error: err.expose ? err.message : '服务器错误' }, err.status ?? 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (!env.SUB_STORE) return text('这个版本没有绑定 KV（预览版本），请使用正式的 Worker 地址', 503);

  if (parts.length === 0) return text('MyClash 订阅合并 Worker 运行中。合并订阅链接：/sub/<TOKEN>\n');
  if (parts[0] === 'sub' && parts.length === 2 && request.method === 'GET') {
    // 订阅链接直接贴进浏览器网址栏时，跳到管理页自动导入；客户端与管理页的 fetch 不会带这两个标头
    if (request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('accept')?.includes('text/html')) {
      return Response.redirect(`${url.origin}/#${importHash(parts[1], url.searchParams.get('script'))}`, 302);
    }
    return serveSubscription(env, ctx, parts[1], url.origin, url.searchParams.get('script'));
  }
  if (parts[0] === 'api') return api(request, env, ctx, parts.slice(1));
  return json({ error: '找不到' }, 404);
}

// --- 订阅输出 ---

// 管理页读取的网址片段：#import=<TOKEN>&script=lite（片段不会发给服务器）
function importHash(token, script) {
  const params = new URLSearchParams({ import: token });
  if (Object.hasOwn(OVERRIDES, script ?? '')) params.set('script', script);
  return params.toString();
}

async function serveSubscription(env, ctx, token, origin, script) {
  const override = script === null ? null : Object.hasOwn(OVERRIDES, script) ? OVERRIDES[script] : undefined;
  if (override === undefined) return text('script 参数只能是 lite（精简）或 full（全量），不覆写请去掉这个参数', 400);
  const record = /^[a-f0-9]{32}$/.test(token) ? await env.SUB_STORE.get(KEY_PREFIX + token, 'json') : null;
  if (!record) return text('找不到这个 TOKEN（可能已删除或已更换）', 404);

  const mode = record.prefixMode ?? 'index';
  const results = await Promise.all(record.sources.map((source, i) => fetchSource(env, ctx, source, i, mode, sourceRate(source, record))));
  numberDuplicatePrefixes(results);
  const ok = results.filter((r) => r.parsed && r.parsed.proxies.length > 0);
  if (ok.length === 0) {
    return results.every((r) => r.blocked)
      ? text('所有机场订阅都已到期或流量用完（已自动屏蔽），请续费或在管理页更换订阅', 502)
      : results.some((r) => r.excluded)
        ? text('所有节点都被排除了（节点筛选），请在管理页调整', 502)
        : text('所有机场订阅都抓取失败、已屏蔽或没有节点，请稍后再试', 502);
  }

  let config = mergeSubscriptions(
    ok.map((r) => ({ prefix: r.prefix, parsed: r.parsed })),
    { rateTag: record.rateTag === true },
  );
  if (override) {
    try {
      config = override.run(config);
    } catch (err) {
      // 返回错误让客户端保留上次的配置，不给半成品
      return text(`套用${override.label}版覆写脚本失败：${err?.message ?? err}`, 502);
    }
  }
  const comments = [
    `MyClash 合并订阅：${record.name}${override ? `，已套用${override.label}版覆写脚本` : ''}`,
    `更新时间：${new Date().toISOString()}`,
    ...results.map((r) =>
      r.blocked
        ? `[${r.label}] 已屏蔽：${r.blocked}` +
          (r.cachedAt ? `（直连失败：${r.directError}，依 ${cacheAge(r.cachedAt)}的缓存判断）` : '')
        : r.parsed
          ? `[${r.label}] ${r.parsed.proxies.length} 个节点${r.excluded ? `（已排除 ${r.excluded} 个）` : ''}${r.parsed.skipped ? `（${r.parsed.skipped} 个无法解析已略过）` : ''}${r.parsed.duplicates ? `（${r.parsed.duplicates} 个重复已去掉）` : ''}` +
            (r.cachedAt ? `（直连失败：${r.directError}，使用 ${cacheAge(r.cachedAt)}的缓存）` : '')
          : `[${r.label}] 失败：${r.error}`,
    ),
  ];

  const headers = {
    'Content-Type': 'text/yaml; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    'Profile-Update-Interval': '6',
    // 客户端订阅卡片上的「首页」按钮，打开管理页并自动导入这个订阅
    'Profile-Web-Page-Url': `${origin}/#${importHash(token, script)}`,
    'Cache-Control': 'no-store',
  };
  const userinfo = sumUserinfo(ok.map((r) => r.userinfo));
  if (userinfo) headers['Subscription-Userinfo'] = userinfo;

  return new Response(dumpConfig(config, comments), { headers });
}

// 同一家机场有两份订阅时简称会一样，第二份起加序号（良心云、良心云2），免得节点名称分不出来
function numberDuplicatePrefixes(results) {
  const seen = new Map();
  for (const r of results) {
    if (!r.prefix) continue;
    const n = (seen.get(r.prefix) ?? 0) + 1;
    seen.set(r.prefix, n);
    if (n > 1) {
      if (r.label === r.prefix) r.label += n;
      r.prefix += n;
    }
  }
}

async function fetchSource(env, ctx, source, index, mode, excludeRate) {
  const fallback = source.name || `S${index + 1}`;
  let label = fallback;
  let prefix = mode === 'none' ? '' : fallback;
  const got = await loadSource(env, ctx, source.url);
  if (!source.name) {
    const detected = detectAirportName(got.disposition, source.url);
    if (detected) {
      label = detected;
      if (mode === 'name') prefix = detected;
    }
  }
  if (got.error) return { label, prefix, error: got.error };
  // 到期或流量用完：节点多半已不能用，整个机场跳过（不解析节点），流量与到期日也不计入合并后的订阅
  if (got.blocked) return { label, prefix, blocked: blockReason(got), cachedAt: got.cachedAt, directError: got.directError };
  const all = got.parsed ?? parseSubscription(got.body);
  if (all.proxies.length === 0) return { label, prefix, parsed: all, error: '没有可用节点' };
  const { proxies, excluded } = filterProxies(all.proxies, { exclude: source.exclude, excludeRate });
  const parsed = { ...all, proxies };
  // 节点全被排除的机场等于没用，流量与到期日也不计入
  if (proxies.length === 0) return { label, prefix, parsed, excluded, error: `${excluded} 个节点全被排除` };
  return { label, prefix, parsed, excluded, userinfo: got.userinfo, cachedAt: got.cachedAt, directError: got.directError };
}

/**
 * 取得机场订阅的唯一方式：每个机场一份 KV 缓存（Worker 抓成功就写回，GitHub Actions 定时代抓屏蔽 Cloudflare 的机场）。
 * 缓存不到 FRESH_MS 就直接用，不连机场；更旧的先连机场，有旧缓存时最多等 STALE_WAIT_MS，
 * 等不到或失败就用旧缓存（并标出 cachedAt 与 directError），背景继续抓完写回缓存。
 * refresh = true（编辑页「重新检查」）时不用新鲜缓存。顺便解析流量与到期日，blocked 为 expired / exhausted 时由调用者屏蔽
 */
async function loadSource(env, ctx, url, { refresh = false } = {}) {
  const key = await cacheKey(url);
  const cached = await env.SUB_STORE.get(key, 'json').catch(() => null);
  if (cached?.body && !refresh && Date.now() - cached.fetchedAt < FRESH_MS) return withStatus(cached);

  // 没有缓存又刚失败过的机场，5 分钟内直接回报同一个错误，不再每次等它失败或超时
  const failed = recentFailures.get(url);
  if (!cached?.body && !refresh && failed && Date.now() - failed.at < FAILURE_MS) return withStatus(failed.got);

  const live = fetchUpstream(url).then((got) => {
    // 只缓存解析得出节点的内容，避免把错误页存进去
    const parsed = got.error ? null : parseSubscription(got.body);
    if (!parsed?.proxies.length) {
      const failure = { disposition: got.disposition, error: got.error ?? '没有可用节点' };
      recentFailures.set(url, { at: Date.now(), got: failure });
      return failure;
    }
    recentFailures.delete(url);
    const entry = { body: got.body, disposition: got.disposition, userinfo: got.userinfo, fetchedAt: Date.now() };
    background(ctx, env.SUB_STORE.put(key, JSON.stringify(entry), { expirationTtl: CACHE_TTL_SECONDS }));
    return { ...entry, parsed };
  });
  if (!cached?.body) return withStatus(await live);

  const got = await Promise.race([live, sleep(STALE_WAIT_MS)]);
  if (got && !got.error) return withStatus(got);
  if (!got) background(ctx, live);
  return withStatus({ ...cached, cachedAt: cached.fetchedAt, directError: got?.error ?? '机场回应太慢' });
}

function withStatus(got) {
  const info = parseUserinfo(got.userinfo);
  return { ...got, info, blocked: isExpired(info) ? 'expired' : isExhausted(info) ? 'exhausted' : null };
}

async function fetchUpstream(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const disposition = res.headers.get('content-disposition');
    if (!res.ok) return { disposition, error: `HTTP ${res.status}${await refusal(res)}` };
    return { disposition, userinfo: res.headers.get('subscription-userinfo'), body: await res.text() };
  } catch (err) {
    return { error: err?.name === 'TimeoutError' ? '超时' : '连接失败' };
  }
}

// 机场面板拒绝时常回 JSON 说明原因（例如 MNKCloud 的 {"message":"token is error"} 表示订阅链接已失效），附在错误后面
async function refusal(res) {
  try {
    const data = JSON.parse((await res.text()).slice(0, 2000));
    const reason = data?.message ?? data?.msg ?? data?.error;
    return typeof reason === 'string' && reason.trim() ? `：${reason.trim().slice(0, 60)}` : '';
  } catch {
    return '';
  }
}

// 回应送出后继续执行（背景更新缓存）；测试没有 ctx 时直接让它跑完
function background(ctx, promise) {
  const settled = promise.catch(() => {});
  ctx?.waitUntil?.(settled);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

function blockReason({ blocked, info }) {
  return blocked === 'expired'
    ? `订阅已于 ${fmtDate(info.expire)} 到期`
    : `流量已用完（${fmtGb(info.upload + info.download)} / ${fmtGb(info.total)}）`;
}

// 订阅注释里的日期用 UTC+8（台湾时间）
function fmtDate(sec) {
  return new Date(sec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function fmtGb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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

async function api(request, env, ctx, parts) {
  const { method } = request;
  if (parts.length === 1 && parts[0] === 'scripts' && method === 'GET') return syncStatus(env);
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
  if (parts.length === 3 && parts[2] === 'sync-scripts' && method === 'POST') return triggerSync(env);
  if (parts.length === 3 && parts[2] === 'sources' && method === 'GET') {
    return sourceDetails(env, ctx, record, new URL(request.url).searchParams.get('refresh') === '1');
  }

  if (parts.length === 3 && parts[2] === 'rotate' && method === 'POST') {
    const next = newToken();
    const updated = { ...record, updatedAt: Date.now() };
    await putRecord(env, next, updated);
    await env.SUB_STORE.delete(KEY_PREFIX + token);
    return json({ token: next, ...updated });
  }

  throw new HttpError(405, '不支持的操作');
}

function githubHeaders(env) {
  return {
    ...(env.GITHUB_TOKEN && { Authorization: `Bearer ${env.GITHUB_TOKEN}` }),
    Accept: 'application/vnd.github+json',
    'User-Agent': 'myclash-worker',
  };
}

// 触发 GitHub Actions 的 workflow，冷却期间不再触发
async function dispatchWorkflow(env, { workflow, cooldownKey, cooldownSeconds, what, busy }) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    throw new HttpError(501, `还没设置 GITHUB_TOKEN，无法从管理页${what}（设置方法见 README）`);
  }
  if (await env.SUB_STORE.get(cooldownKey)) throw new HttpError(429, busy);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) throw new HttpError(502, `触发 GitHub Actions 失败：HTTP ${res.status}（检查 GITHUB_TOKEN 的权限）`);
  await env.SUB_STORE.put(cooldownKey, '1', { expirationTtl: cooldownSeconds });
  return json({ ok: true });
}

function triggerRefresh(env) {
  return dispatchWorkflow(env, {
    workflow: REFRESH_WORKFLOW,
    cooldownKey: REFRESH_COOLDOWN_KEY,
    cooldownSeconds: REFRESH_COOLDOWN_SECONDS,
    what: '刷新缓存',
    busy: '刚刷新过，请 1 分钟后再试',
  });
}

async function triggerSync(env) {
  const res = await dispatchWorkflow(env, {
    workflow: SYNC_WORKFLOW,
    cooldownKey: SYNC_COOLDOWN_KEY,
    cooldownSeconds: SYNC_COOLDOWN_SECONDS,
    what: '同步覆写脚本',
    busy: '刚同步过，请 10 分钟后再试',
  });
  // 让管理页下次读到新的执行状态
  await env.SUB_STORE.delete(SYNC_STATUS_KEY);
  return res;
}

// 「同步上游覆写脚本」最近一次执行，与 rules 分支（覆写脚本与规则集的生成物）最后一次有改动的提交；没设 GITHUB_TOKEN 也能读（公开仓库）
async function syncStatus(env) {
  if (!env.GITHUB_REPO) throw new HttpError(501, '没有设置 GITHUB_REPO');
  const cached = await env.SUB_STORE.get(SYNC_STATUS_KEY, 'json');
  if (cached) return json(cached);

  const base = `https://api.github.com/repos/${env.GITHUB_REPO}`;
  const get = async (path) => {
    const res = await fetch(base + path, { headers: githubHeaders(env) });
    if (!res.ok) throw new HttpError(502, `读取 GitHub 失败：HTTP ${res.status}`);
    return res.json();
  };
  const [runs, commits] = await Promise.all([
    get(`/actions/workflows/${SYNC_WORKFLOW}/runs?per_page=1`),
    get('/commits?sha=rules&path=script.js&per_page=1'),
  ]);
  const run = runs.workflow_runs?.[0];
  const commit = commits[0];
  const status = {
    run: run
      ? { status: run.status, conclusion: run.conclusion, event: run.event, createdAt: Date.parse(run.created_at), url: run.html_url }
      : null,
    updated: commit
      ? { at: Date.parse(commit.commit.committer.date), message: commit.commit.message.split('\n')[0], url: commit.html_url }
      : null,
    canTrigger: Boolean(env.GITHUB_TOKEN),
  };
  // 还在执行时只存 1 分钟（KV 最短），好让管理页尽快看到结果
  const ttl = run && run.status !== 'completed' ? 60 : SYNC_STATUS_TTL;
  await env.SUB_STORE.put(SYNC_STATUS_KEY, JSON.stringify(status), { expirationTtl: ttl });
  return json(status);
}

// 编辑页：每个机场的流量、到期日、是否屏蔽与原本的节点名称和倍率（未筛选；已屏蔽的机场也列出，续费后就照这里的选择）。
// 跟合并订阅用同一份缓存；refresh 为「重新检查」，不用新鲜缓存
async function sourceDetails(env, ctx, record, refresh) {
  const sources = await Promise.all(
    record.sources.map(async ({ url }) => {
      const got = await loadSource(env, ctx, url, { refresh });
      // 同名节点在筛选时一起处理，只列一次
      const names = got.body ? [...new Set((got.parsed ?? parseSubscription(got.body)).proxies.map((p) => String(p.name)))] : [];
      return {
        url,
        name: detectAirportName(got.disposition, url),
        error: got.error ?? null,
        directError: got.directError ?? null,
        cachedAt: got.cachedAt ?? null,
        fetchedAt: got.fetchedAt ?? null,
        info: got.info,
        blocked: got.blocked,
        nodes: names.map((name) => ({ name, rate: extractRate(name).rate })),
      };
    }),
  );
  return json({ checkedAt: Date.now(), sources });
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
    const exclude = Array.isArray(s?.exclude) ? [...new Set(s.exclude.filter((n) => typeof n === 'string' && n && n.length <= MAX_NODE_NAME))] : [];
    if (exclude.length > MAX_EXCLUDE) throw new HttpError(400, `第 ${i + 1} 个机场最多排除 ${MAX_EXCLUDE} 个节点`);
    const source = { name: sourceName, url };
    if (exclude.length) source.exclude = exclude;
    // 这个机场自己的倍率门槛：没有这个键就跟随全局，null 表示不限
    if (s?.excludeRate === null) source.excludeRate = null;
    else if (validRate(s?.excludeRate) !== null) source.excludeRate = validRate(s.excludeRate);
    return source;
  });
  const prefixMode = PREFIX_MODES.includes(input.prefixMode) ? input.prefixMode : 'name';
  // 全局：倍率 ≥ excludeRate 的节点不导入；null 表示不限
  return { name, prefixMode, rateTag: input.rateTag === true, excludeRate: validRate(input.excludeRate), sources };
}

function validRate(v) {
  const rate = typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

// 机场的倍率门槛：自己设了就用自己的（null 表示不限），否则跟随全局
function sourceRate(source, record) {
  return Object.hasOwn(source, 'excludeRate') ? source.excludeRate : (record.excludeRate ?? null);
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
