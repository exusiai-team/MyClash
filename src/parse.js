import * as yaml from 'js-yaml';

// 合并后设置档里唯一的策略组名称，套用 Script.js 覆写后会被整个取代
export const GROUP_NAME = '节点选择';

/**
 * 解析单一订阅内容（mihomo YAML 或 base64 / 纯文本 URI 列表）
 * @returns {{ proxies: object[], dns: object | null, hosts: object | null, skipped: number, duplicates: number }}
 */
export function parseSubscription(text) {
  const body = String(text ?? '').replace(/^﻿/, '').trim();
  if (!body) return { proxies: [], dns: null, hosts: null, skipped: 0, duplicates: 0 };

  const parsed = tryParseYaml(body) ?? parseUriList(body);
  const { proxies, duplicates } = dedupeProxies(parsed.proxies);
  return { ...parsed, proxies, duplicates };
}

/**
 * 自建节点（AI 链式代理的落地节点）：mihomo YAML（proxies: 清单、节点清单或单个节点），
 * 或分享链接（一行一个，也可以整段 base64）
 * @returns {object[]}
 */
export function parseNodes(text) {
  const body = String(text ?? '').trim();
  if (!body) return [];
  let doc = null;
  try {
    doc = yaml.load(body);
  } catch {}
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.proxies) ? doc.proxies : isPlainObject(doc) && doc.name && doc.type ? [doc] : null;
  if (list) return list.filter((p) => isPlainObject(p) && p.name && p.type);
  return parseUriList(body).proxies;
}

// 「剩余流量」「套餐到期」「官网」等信息节点：机场常直接复制某个真节点的设置、只改名称，排在最前面
const INFO_NODE_RE = /剩余|到期|过期|重置|流量|官网|网站|网址|官方|套餐|订阅|客服|群/;

/**
 * 去掉除了名称以外完全相同的节点（机场常把同一个节点换几个名字重复列），保留第一个；
 * dialer-proxy 指向被去掉的节点的，改指保留下来的那个。
 * 信息节点不参与：不然排在前面的信息节点会顶掉跟它设置相同的真节点，信息节点之后又被覆写脚本滤掉，真节点就没了
 */
export function dedupeProxies(proxies) {
  const kept = [];
  const byConfig = new Map();
  const renamed = new Map();
  for (const proxy of proxies) {
    const { name, ...rest } = proxy;
    if (INFO_NODE_RE.test(String(name))) {
      kept.push(proxy);
      continue;
    }
    const key = stableStringify(rest);
    const first = byConfig.get(key);
    if (first !== undefined) {
      renamed.set(name, first);
      continue;
    }
    byConfig.set(key, name);
    kept.push(proxy);
  }
  if (renamed.size === 0) return { proxies, duplicates: 0 };
  const fixed = kept.map((p) => (renamed.has(p['dialer-proxy']) ? { ...p, 'dialer-proxy': renamed.get(p['dialer-proxy']) } : p));
  return { proxies: fixed, duplicates: renamed.size };
}

// 物件的键排序后再序列化，键顺序不同的相同设置得到同一个字串
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseUriList(body) {
  const lines = (looksLikeUriList(body) ? body : decodeBase64(body) ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const proxies = [];
  let skipped = 0;
  for (const line of lines) {
    const proxy = parseUri(line);
    if (proxy) proxies.push(proxy);
    else skipped++;
  }
  return { proxies, dns: null, hosts: null, skipped };
}

function tryParseYaml(body) {
  let doc;
  try {
    doc = yaml.load(body);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.proxies)) return null;

  const proxies = doc.proxies.filter((p) => p && typeof p === 'object' && p.name && p.type);
  return {
    proxies,
    dns: isPlainObject(doc.dns) ? doc.dns : null,
    hosts: isPlainObject(doc.hosts) ? doc.hosts : null,
    skipped: doc.proxies.length - proxies.length,
  };
}

function looksLikeUriList(body) {
  return /^[a-z][a-z0-9+.-]*:\/\//im.test(body);
}

export function decodeBase64(input) {
  try {
    let s = String(input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function truthy(v) {
  return v === '1' || v === 'true' || v === true;
}

// --- URI 解析 ---

export function parseUri(line) {
  const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
  try {
    switch (scheme) {
      case 'ss':
        return parseSs(line);
      case 'vmess':
        return parseVmess(line);
      case 'vless':
        return parseVless(line);
      case 'trojan':
        return parseTrojan(line);
      case 'hysteria2':
      case 'hy2':
        return parseHysteria2(line);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function splitFragment(line) {
  const i = line.indexOf('#');
  return i === -1 ? [line, ''] : [line.slice(0, i), safeDecode(line.slice(i + 1))];
}

function hostPortName(url, name) {
  const server = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (!server || !port) throw new Error('missing server/port');
  return { name: name || `${server}:${port}`, server, port };
}

// ss://BASE64(method:password)@host:port?plugin=...#name 或 ss://BASE64(method:password@host:port)#name
function parseSs(line) {
  const [main, name] = splitFragment(line);
  let rest = main.slice('ss://'.length);
  const q = rest.indexOf('?');
  const query = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));
  if (q !== -1) rest = rest.slice(0, q);
  rest = rest.replace(/\/$/, '');

  let userinfo;
  let hostport;
  if (rest.includes('@')) {
    const at = rest.lastIndexOf('@');
    const raw = safeDecode(rest.slice(0, at));
    userinfo = raw.includes(':') ? raw : decodeBase64(raw);
    hostport = rest.slice(at + 1);
  } else {
    const decoded = decodeBase64(rest) ?? '';
    const at = decoded.lastIndexOf('@');
    userinfo = decoded.slice(0, at);
    hostport = decoded.slice(at + 1);
  }
  const colon = userinfo?.indexOf(':') ?? -1;
  if (colon <= 0) return null;

  const url = new URL(`x://${hostport}`);
  const proxy = {
    ...hostPortName(url, name),
    type: 'ss',
    cipher: userinfo.slice(0, colon),
    password: userinfo.slice(colon + 1),
    udp: true,
  };

  const plugin = query.get('plugin');
  if (plugin) {
    const [pluginName, ...opts] = plugin.split(';');
    const kv = Object.fromEntries(
      opts.map((o) => {
        const i = o.indexOf('=');
        return i === -1 ? [o, 'true'] : [o.slice(0, i), o.slice(i + 1)];
      }),
    );
    if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
      proxy.plugin = 'obfs';
      proxy['plugin-opts'] = { mode: kv.obfs ?? 'http', host: kv['obfs-host'] ?? '' };
    } else if (pluginName === 'v2ray-plugin') {
      proxy.plugin = 'v2ray-plugin';
      proxy['plugin-opts'] = {
        mode: kv.mode ?? 'websocket',
        tls: 'tls' in kv,
        host: kv.host ?? '',
        path: kv.path ?? '/',
      };
    } else {
      return null;
    }
  }
  return proxy;
}

function applyTransport(proxy, network, { path, host, serviceName }) {
  const net = network || 'tcp';
  if (net === 'tcp') return;
  proxy.network = net;
  if (net === 'ws') {
    proxy['ws-opts'] = { path: path || '/', ...(host ? { headers: { Host: host } } : {}) };
  } else if (net === 'grpc') {
    proxy['grpc-opts'] = { 'grpc-service-name': serviceName || path || '' };
  } else if (net === 'h2') {
    proxy['h2-opts'] = { path: path || '/', ...(host ? { host: [host] } : {}) };
  } else if (net === 'http') {
    proxy['http-opts'] = { path: [path || '/'], ...(host ? { headers: { Host: [host] } } : {}) };
  }
}

// vmess://BASE64(JSON)
function parseVmess(line) {
  const json = JSON.parse(decodeBase64(line.slice('vmess://'.length)) ?? '');
  const port = Number(json.port);
  if (!json.add || !port || !json.id) return null;
  const proxy = {
    name: json.ps || `${json.add}:${port}`,
    type: 'vmess',
    server: json.add,
    port,
    uuid: json.id,
    alterId: Number(json.aid) || 0,
    cipher: json.scy || 'auto',
    udp: true,
  };
  if (json.tls === 'tls') {
    proxy.tls = true;
    if (json.sni || json.host) proxy.servername = json.sni || json.host;
    if (json.alpn) proxy.alpn = String(json.alpn).split(',');
    if (json.fp) proxy['client-fingerprint'] = json.fp;
  }
  applyTransport(proxy, json.net, { path: json.path, host: json.host, serviceName: json.path });
  return proxy;
}

function applyTlsParams(proxy, p, sniKey) {
  const security = p.get('security');
  const sni = p.get('sni') || p.get('peer');
  if (sni) proxy[sniKey] = sni;
  if (p.get('fp')) proxy['client-fingerprint'] = p.get('fp');
  if (p.get('alpn')) proxy.alpn = p.get('alpn').split(',');
  if (truthy(p.get('allowInsecure')) || truthy(p.get('insecure'))) proxy['skip-cert-verify'] = true;
  if (security === 'reality') {
    proxy['reality-opts'] = { 'public-key': p.get('pbk') ?? '', 'short-id': p.get('sid') ?? '' };
  }
}

// vless://uuid@host:port?security=tls|reality&type=ws&...#name
function parseVless(line) {
  const [main, name] = splitFragment(line);
  const url = new URL(main.replace(/^vless:/i, 'x:'));
  const p = url.searchParams;
  const security = p.get('security') || 'none';
  const proxy = {
    ...hostPortName(url, name),
    type: 'vless',
    uuid: safeDecode(url.username),
    udp: true,
  };
  if (!proxy.uuid) return null;
  if (p.get('flow')) proxy.flow = p.get('flow');
  if (security === 'tls' || security === 'reality') {
    proxy.tls = true;
    applyTlsParams(proxy, p, 'servername');
  }
  applyTransport(proxy, p.get('type'), {
    path: p.get('path'),
    host: p.get('host'),
    serviceName: p.get('serviceName'),
  });
  return proxy;
}

// trojan://password@host:port?sni=...&type=ws#name
function parseTrojan(line) {
  const [main, name] = splitFragment(line);
  const url = new URL(main.replace(/^trojan:/i, 'x:'));
  const p = url.searchParams;
  const proxy = {
    ...hostPortName(url, name),
    type: 'trojan',
    password: safeDecode(url.username),
    udp: true,
  };
  if (!proxy.password) return null;
  applyTlsParams(proxy, p, 'sni');
  applyTransport(proxy, p.get('type'), {
    path: p.get('path'),
    host: p.get('host'),
    serviceName: p.get('serviceName'),
  });
  return proxy;
}

// hysteria2://auth@host:port?sni=...&obfs=salamander&obfs-password=...#name
function parseHysteria2(line) {
  const [main, name] = splitFragment(line);
  const url = new URL(main.replace(/^(hysteria2|hy2):/i, 'x:'));
  const p = url.searchParams;
  const password = safeDecode(url.password ? `${url.username}:${url.password}` : url.username);
  const proxy = {
    ...hostPortName(url, name),
    type: 'hysteria2',
    password,
  };
  if (!password) return null;
  if (p.get('sni')) proxy.sni = p.get('sni');
  if (truthy(p.get('insecure'))) proxy['skip-cert-verify'] = true;
  if (p.get('obfs')) {
    proxy.obfs = p.get('obfs');
    if (p.get('obfs-password')) proxy['obfs-password'] = p.get('obfs-password');
  }
  if (p.get('mport')) proxy.ports = p.get('mport');
  return proxy;
}

// --- 合并 ---

// 倍率写法：2x、2.0X、x2、×1.5、*3、2倍、2倍率、倍率:2，可被 []、()、【】、（） 包住；前后不能紧接字母或数字
const RATE_RE =
  /([\s|｜_\-·]*)[\[(【（]?\s*(?:(?<![A-Za-z\d.])(\d+(?:\.\d+)?)\s*(?:[x×✕✖⨯*](?![A-Za-z\d])|倍率?)|(?<![A-Za-z\d])[x×✕✖⨯*]\s*(\d+(?:\.\d+)?)(?![\d.])|倍率\s*[:：]?\s*(\d+(?:\.\d+)?))\s*[\])】）]?([\s|｜_\-·]*)/i;

/**
 * 从节点名称取出倍率，并返回去掉倍率标记后的名称；「剩余流量」「到期」等信息节点不处理
 * @returns {{ rate: number | null, rest: string }}
 */
export function extractRate(name) {
  const str = String(name);
  const m = /剩|期/.test(str) ? null : str.match(RATE_RE);
  const rate = m ? Number(m[2] ?? m[3] ?? m[4]) : NaN;
  if (!Number.isFinite(rate)) return { rate: null, rest: str };
  const before = str.slice(0, m.index);
  const after = str.slice(m.index + m[0].length);
  // 倍率夹在中间时保留一个分隔符（优先用后面的），例如「台湾01-1.0x |移联」→「台湾01 |移联」
  const sep = before && after ? (m[5] || m[1]) : '';
  return { rate, rest: (before + sep + after).trim() || str };
}

/** 节点倍率；名称没有标倍率的算 1 倍 */
function nodeRate(name) {
  return extractRate(name).rate ?? 1;
}

/**
 * 节点筛选：去掉手动排除的节点（按机场原本的节点名称）与倍率 ≥ excludeRate 的节点；
 * dialer-proxy 指向被去掉的节点的，链路已断，一并去掉
 * @param {object[]} proxies
 * @param {{ exclude?: string[], excludeRate?: number | null }} [options]
 * @returns {{ proxies: object[], excluded: number }}
 */
export function filterProxies(proxies, { exclude = [], excludeRate = null } = {}) {
  const manual = new Set(exclude);
  const removed = new Set();
  for (const p of proxies) {
    if (manual.has(p.name) || (excludeRate !== null && nodeRate(p.name) >= excludeRate)) removed.add(p.name);
  }
  if (removed.size === 0) return { proxies, excluded: 0 };
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of proxies) {
      if (!removed.has(p.name) && removed.has(p['dialer-proxy'])) {
        removed.add(p.name);
        changed = true;
      }
    }
  }
  const kept = proxies.filter((p) => !removed.has(p.name));
  return { proxies: kept, excluded: proxies.length - kept.length };
}

function formatRate(rate) {
  return `${rate}x`;
}

// rateTag 开启时：前缀 | 2x | 原名；1 倍只去掉原本的倍率标记，不加标注
function displayName(prefix, name, rateTag) {
  const parts = prefix ? [prefix] : [];
  if (rateTag) {
    const { rate, rest } = extractRate(name);
    if (rate !== null && rate !== 1) parts.push(formatRate(rate));
    parts.push(rest);
  } else {
    parts.push(String(name));
  }
  return parts.join(' | ');
}

/**
 * 合并多份订阅为一份可直接被 Script.js 覆写的 mihomo 设置（不含 proxy-providers）
 * @param {{ prefix: string, parsed: ReturnType<typeof parseSubscription> }[]} sources
 * @param {{ rateTag?: boolean }} [options] rateTag：在节点名称标示倍率
 */
export function mergeSubscriptions(sources, { rateTag = false } = {}) {
  const proxies = [];
  const names = new Set();
  let dns = null;
  let hosts = null;

  for (const { prefix, parsed } of sources) {
    const renamed = new Map();
    for (const proxy of parsed.proxies) {
      const base = displayName(prefix, proxy.name, rateTag);
      let unique = base;
      for (let i = 2; names.has(unique); i++) unique = `${base} ${i}`;
      names.add(unique);
      renamed.set(proxy.name, unique);
      proxies.push({ ...proxy, name: unique });
    }
    // 同一份订阅内的 dialer-proxy 引用跟着改名
    for (let i = proxies.length - parsed.proxies.length; i < proxies.length; i++) {
      const target = proxies[i]['dialer-proxy'];
      if (target && renamed.has(target)) proxies[i]['dialer-proxy'] = renamed.get(target);
    }

    if (parsed.hosts) hosts = { ...(hosts ?? {}), ...parsed.hosts };
    if (parsed.dns) dns = mergeDns(dns, parsed.dns);
  }

  const config = {};
  if (dns) config.dns = dns;
  if (hosts) config.hosts = hosts;
  config.proxies = proxies;
  config['proxy-groups'] = [
    { name: GROUP_NAME, type: 'select', proxies: proxies.length ? proxies.map((p) => p.name) : ['DIRECT'] },
  ];
  config.rules = [`MATCH,${GROUP_NAME}`];
  return config;
}

function mergeDns(acc, next) {
  if (!acc) return { ...next };
  const merged = { ...acc };
  for (const key of ['nameserver-policy', 'proxy-server-nameserver-policy']) {
    if (isPlainObject(next[key])) merged[key] = { ...(acc[key] ?? {}), ...next[key] };
  }
  if (!merged['proxy-server-nameserver']?.length && next['proxy-server-nameserver']?.length) {
    merged['proxy-server-nameserver'] = next['proxy-server-nameserver'];
  }
  return merged;
}

/**
 * 解析 subscription-userinfo header
 * @returns {{ upload: number, download: number, total: number, expire: number } | null} expire 是 Unix 秒数，0 表示没有到期日
 */
export function parseUserinfo(value) {
  if (!value) return null;
  const info = { upload: 0, download: 0, total: 0, expire: 0 };
  for (const part of String(value).split(';')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    const n = Number(v);
    if (Object.hasOwn(info, k) && Number.isFinite(n) && n > 0) info[k] = n;
  }
  return info;
}

/** 订阅的到期日已过（没有到期日的不算） */
export function isExpired(info, now = Date.now()) {
  return info?.expire > 0 && info.expire * 1000 <= now;
}

/** 流量已用完（总流量为 0 表示不限或没提供，不算） */
export function isExhausted(info) {
  return info?.total > 0 && info.upload + info.download >= info.total;
}

/**
 * 加总多个 subscription-userinfo header：流量相加，到期日取最早的
 */
export function sumUserinfo(values) {
  const infos = values.map(parseUserinfo).filter(Boolean);
  if (infos.length === 0) return null;
  const sum = (k) => infos.reduce((n, info) => n + info[k], 0);
  const expires = infos.map((info) => info.expire).filter((e) => e > 0);
  const expire = expires.length ? Math.min(...expires) : 0;
  return `upload=${sum('upload')}; download=${sum('download')}; total=${sum('total')}; expire=${expire}`;
}

export function dumpConfig(config, comments = []) {
  const header = comments.map((c) => `# ${c}`).join('\n');
  const body = dumpYaml(config);
  return header ? `${header}\n${body}` : body;
}

// --- 输出 YAML ---
// 自己写的精简 YAML 输出：js-yaml 的 dump 会逐字检查该用哪种写法，几百个节点就要花掉 Workers 免费方案大半的 CPU 时间；
// 这里只用两种写法，快 10 倍以上：
// - 简单字符串（字母、数字、中文、- _ . / + @ 空格，且不像数字或布尔值）不加引号，其余一律用 JSON 的双引号写法（也是合法的 YAML）
// - proxies 每个节点一行（flow 写法，机场订阅常见的格式），其余用缩进的 block 写法

const PLAIN = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_\-./+@ ]*[\p{L}\p{N}_\-./+@])?$/u;
// YAML 1.1 会当成布尔值或空值的字；数字开头的一律加引号，避免被当成数字
const RESERVED = /^(?:true|false|yes|no|on|off|y|n|null)$/i;

// 同一个节点名称会在各个策略组里重复出现几十次，判断结果记下来重复使用（每次输出重新开始）
let scalarCache = new Map();
function scalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return String(v);
  const s = String(v);
  let out = scalarCache.get(s);
  if (out === undefined) {
    out = PLAIN.test(s) && !RESERVED.test(s) && !/^\d/.test(s) ? s : quote(s);
    scalarCache.set(s, out);
  }
  return out;
}

// JSON 没转义、但 YAML 当成换行（U+2028、U+2029、U+0085）或不可打印的字符，补上 \u 转义
const NON_PRINTABLE = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;
function quote(s) {
  return JSON.stringify(s).replace(NON_PRINTABLE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entries = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined);

function flow(v) {
  if (Array.isArray(v)) return `[${v.filter((x) => x !== undefined).map(flow).join(', ')}]`;
  if (isMap(v)) return `{${entries(v).map(([k, x]) => `${scalar(k)}: ${flow(x)}`).join(', ')}}`;
  return scalar(v);
}

// 空的 map / 数组和标量写在同一行
const inline = (v) => (Array.isArray(v) || isMap(v) ? flow(v) : scalar(v));
const isBlock = (v) => (Array.isArray(v) ? v.length > 0 : isMap(v) && entries(v).length > 0);

function blockMap(obj, indent, lines, top = false) {
  for (const [k, v] of entries(obj)) {
    const key = indent + scalar(k) + ':';
    if (!isBlock(v)) lines.push(`${key} ${inline(v)}`);
    else if (Array.isArray(v)) {
      lines.push(key);
      blockSeq(v, indent + '  ', lines, top && k === 'proxies');
    } else {
      lines.push(key);
      blockMap(v, indent + '  ', lines);
    }
  }
}

function blockSeq(arr, indent, lines, flowItems) {
  for (const v of arr) {
    if (v === undefined) continue;
    if (flowItems || !isBlock(v)) lines.push(`${indent}- ${inline(v)}`);
    else if (Array.isArray(v)) {
      lines.push(`${indent}-`);
      blockSeq(v, indent + '  ', lines, false);
    } else {
      // map 的第一个键接在「- 」后面
      const start = lines.length;
      blockMap(v, indent + '  ', lines);
      lines[start] = `${indent}- ${lines[start].slice(indent.length + 2)}`;
    }
  }
}

export function dumpYaml(config) {
  const lines = [];
  scalarCache = new Map();
  try {
    blockMap(config, '', lines, true);
  } finally {
    scalarCache = new Map();
  }
  return lines.join('\n') + '\n';
}

/*
 * 机场简称：不逐个对照名称，只按写法规则把订阅文件名（或域名）缩成节点前缀
 * 1. 文件名本身是网址就取主域名；网址、emoji、括号拆掉
 * 2. 按 | / · 、「 - 」等分隔符切段，取第一个还有内容的段，后面多半是口号或网址（一元机场 - 官网 yiyuan.xyz）
 * 3. 去掉会让覆写脚本误判节点的字（见 CONFLICT_*）
 * 4. 去掉通用词 Cloud、Net、Link、VPN、网络、加速器…，独立成词或黏在后面（FSCloud、SingLink、猫熊网络加速器）都去掉；
 *    结尾的「云」剩 2 个字以上才去掉（良心云 → 良心，念云、69云不动）
 * 5. 中英并列（Nexitally 奶昔、WestData西部数据）只留中文，中文剩一个字（大机场 Big Airport）就留英文
 * 6. 显示宽度超过 MAX_NAME_WIDTH（中日韩字算 2）从后面去词
 * 全部去光或只剩一个字（clash、config、一串随机字符、永久免费云）就改用订阅域名；中文域名（xn--）转回中文
 */

// 覆写脚本按节点名称分类，机场简称是每个节点名称的一部分：带到这些字，整个机场的节点会被当成信息节点删掉（excludeFilter），
// 或全被归到地区、倍率、家宽组。测试会拿覆写脚本的正则逐字核对
const CONFLICT_CJK = new RegExp(
  [
    // excludeFilter
    '群|返利|循环|官网|客服|网站|网址|获取|订阅|流量|到期|机场|下次|版本|官址|备用|过期|已用|联系|邮箱|工单|贩卖|通知|倒卖|防止|国内|地址',
    '频道|电报|无法|说明|提示|访问|支持|教程|关注|更新|作者|加入|超时|收藏|优惠|福利|邀请|好友|失联|选择|剩余|公益|发布|通路|登录|禁止',
    '定时|渠道|牢记|永久|余额|阁下|本站|刷新|导航|建议|重置|以下|过滤|機場|訂閱|官網',
    // 地区
    '香港|日本|东京|大阪|京都|美国|纽约|洛杉矶|旧金山|芝加哥|休斯顿|迈阿密|西雅图|波士顿|华盛顿|圣何塞|新加坡|狮城|台湾|台北|高雄',
    // 倍率、家宽
    '低倍|免费|下载|家宽|住宅|原生|家庭宽带',
  ].join('|'),
  'g',
);
const CONFLICT_LATIN = /hong\s*kong|japan|america|united\s*states|singapore|taiwan|residential|diztna|[@#]/gi;
const CONFLICT_WORD = /^(?:hkg?|jpn?|usa?|sgp?|twn?|free|isp|res|expire|traffic)$/i;
// 倍率写法（x2、0.5x、2倍）
const RATE_LIKE = /[*×✕✖⨯⨉x]\d|\d(?:\.\d+)?(?:倍|[*×✕✖⨯⨉x])/i;

// 通用词：独立成词或黏在名称后面（FSCloud、SingLink、猫熊网络加速器）都去掉
const NOISE_SUFFIX = /^(.*?)(clouds?|networks?|net|telecom|links?|vpn|prox(?:y|ies)|airport|jichang|tech|加速器|网络|網絡|科技)$/i;
// 客户端、文件名用语：只在独立成词时去掉（只剩这些就整段作废）
const NOISE_WORDS = new Set('clash meta mihomo verge stash config sub subscribe subscription profile official www 配置 节点'.split(' '));

const PART_SEP = /[|｜/\\·•,，;；:：!！?？。、()（）[\]{}<>《》【】〔〕「」『』"“”'‘’]+|\s+[-–—~]+\s+|[–—~]+/;
const URL_LIKE = /(?:[a-z][a-z\d+.-]*:\/\/)?(?:[\p{L}\d-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/giu;
const DOMAIN_ONLY = /^(?:https?:\/\/)?(?:[\p{L}\d-]+\.)+[a-z]{2,}\/?$/iu;
// 中英黏在一起（WestData西部数据）：英文至少 3 个字母、中文至少 2 个字才拆，iceの小店、哆啦A梦不拆
const GLUED_BILINGUAL = /(?<=[a-z]{3})(?=\p{Script=Han}{2})|(?<=\p{Script=Han}{2})(?=[a-z]{3})/iu;
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f]/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const MAX_NAME_WIDTH = 14;

/**
 * 从订阅响应识别机场简称：先看 Content-Disposition 的文件名，没有（或缩完不剩东西）就用订阅域名
 * @param {string | null} contentDisposition
 * @param {string} url
 */
export function detectAirportName(contentDisposition, url) {
  return shortName(fileNameFrom(contentDisposition)) || shortName(domainLabel(url)) || '';
}

export function shortName(raw) {
  let s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .replace(/\.(ya?ml|txt|conf|json)$/i, '');
  if (DOMAIN_ONLY.test(s)) s = domainLabel(/^https?:/i.test(s) ? s : `https://${s}`);
  s = s.replace(URL_LIKE, ' ').replace(PICTOGRAPHIC, ' ').replace(CONFLICT_CJK, ' ').replace(CONFLICT_LATIN, ' ');
  for (const part of s.split(PART_SEP)) {
    const words = part.split(/[\s_-]+/).flatMap((w) => w.split(GLUED_BILINGUAL));
    const name = fitWidth(pickScript(words.map(stripWord).filter(Boolean)));
    // 只剩一个字（永久免费云 → 云）认不出是哪家
    if ([...name].length >= 2) return name;
  }
  return '';
}

function stripWord(word) {
  const w = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!w || NOISE_WORDS.has(w.toLowerCase()) || CONFLICT_WORD.test(w) || RATE_LIKE.test(w)) return '';
  // 随机字符（订阅 token、时间戳）不是名称
  if (/^\d{5,}$/.test(w) || (/^[a-z\d]{16,}$/i.test(w) && /\d/.test(w))) return '';
  // 剩一个字（XCloud → X）由 shortName 判定认不出、改用域名，简称里不留通用词
  const glued = w.match(NOISE_SUFFIX);
  if (glued) return stripWord(glued[1]);
  // 结尾的「云」也是通用词，但剩一个字或纯数字（念云、69云）就认不出，保留
  const yun = w.match(/^(.+)[云雲]$/u);
  return yun && [...yun[1]].length >= 2 && !/^\d+$/.test(yun[1]) ? stripWord(yun[1]) : w;
}

// 中英并列只留一种：优先中文，中文只剩一个字就留英文
function pickScript(words) {
  const cjk = words.filter((w) => CJK.test(w));
  const latin = words.filter((w) => !CJK.test(w));
  return (cjk.length && (displayWidth(cjk.join('')) >= 4 || !latin.length) ? cjk : latin).join(' ');
}

function fitWidth(name) {
  const words = name.split(' ');
  while (words.length > 1 && displayWidth(words.join(' ')) > MAX_NAME_WIDTH) words.pop();
  let out = '';
  for (const ch of words.join(' ')) {
    if (displayWidth(out + ch) > MAX_NAME_WIDTH) break;
    out += ch;
  }
  return out;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

function fileNameFrom(cd) {
  if (!cd) return '';
  const star = cd.match(/filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i);
  if (star) return safeDecode(star[1].trim().replace(/^"|"$/g, ''));
  const plain = cd.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  return plain ? safeDecode((plain[2] ?? plain[1]).trim()) : '';
}

function domainLabel(url) {
  try {
    const labels = new URL(url).hostname.split('.').filter(Boolean);
    if (labels.length === 0 || /^\d+$/.test(labels[labels.length - 1])) return ''; // IP 不当名称
    // 取主域名，例如 sub.example.co.uk → example、api.foo.com → foo
    const tail = labels.length >= 3 && /^(com|net|org|co|ac|gov|edu)$/.test(labels[labels.length - 2]) ? 3 : 2;
    return punycodeDecode(labels[labels.length - tail] ?? labels[0]);
  } catch {
    return '';
  }
}

// 中文域名（xn--9kqs1lo79d → 吹雪云），RFC 3492；格式不对就不当名称
function punycodeDecode(label) {
  if (!/^xn--/i.test(label)) return label;
  const input = label.slice(4).toLowerCase();
  const sep = input.lastIndexOf('-');
  const out = sep > 0 ? [...input.slice(0, sep)].map((c) => c.codePointAt(0)) : [];
  let n = 128;
  let i = 0;
  let bias = 72;
  for (let p = sep > 0 ? sep + 1 : 0; p < input.length; ) {
    const old = i;
    for (let w = 1, k = 36; ; k += 36) {
      const c = input.charCodeAt(p++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : 36;
      if (digit >= 36) return '';
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
    }
    const len = out.length + 1;
    let delta = old === 0 ? Math.floor((i - old) / 700) : Math.floor((i - old) / 2);
    delta += Math.floor(delta / len);
    let k = 0;
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
    bias = k + Math.floor((36 * delta) / (delta + 38));
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return '';
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
