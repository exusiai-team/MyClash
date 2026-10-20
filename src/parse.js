import * as yaml from 'js-yaml';

// 合并后设置档里唯一的策略组名称，套用 Script.js 覆写后会被整个取代
export const GROUP_NAME = '节点选择';

/**
 * 解析单一订阅内容（mihomo YAML 或 base64 / 纯文本 URI 列表）
 * @returns {{ proxies: object[], dns: object | null, hosts: object | null, skipped: number }}
 */
export function parseSubscription(text) {
  const body = String(text ?? '').replace(/^﻿/, '').trim();
  if (!body) return { proxies: [], dns: null, hosts: null, skipped: 0 };

  const fromYaml = tryParseYaml(body);
  if (fromYaml) return fromYaml;

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
 * 加总多个 subscription-userinfo header：流量相加，到期日取最早的
 */
export function sumUserinfo(values) {
  const total = { upload: 0, download: 0, total: 0 };
  let expire = 0;
  let seen = false;
  for (const value of values) {
    if (!value) continue;
    seen = true;
    for (const part of value.split(';')) {
      const [k, v] = part.split('=').map((s) => s.trim());
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (k in total) total[k] += n;
      else if (k === 'expire' && n > 0) expire = expire ? Math.min(expire, n) : n;
    }
  }
  if (!seen) return null;
  return `upload=${total.upload}; download=${total.download}; total=${total.total}; expire=${expire}`;
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

// 机场名称里这些字会被 MyClash 脚本当成「信息节点」过滤掉，所以去掉
const NAME_NOISE = /机场|機場|订阅|訂閱|官网|官網/g;

/**
 * 从订阅响应识别机场名称：先看 Content-Disposition 的文件名，没有就用订阅域名
 * @param {string | null} contentDisposition
 * @param {string} url
 */
export function detectAirportName(contentDisposition, url) {
  return cleanName(fileNameFrom(contentDisposition)) || cleanName(domainLabel(url)) || '';
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
    return labels[labels.length - tail] ?? labels[0];
  } catch {
    return '';
  }
}

function cleanName(name) {
  return String(name ?? '')
    .replace(/\.(ya?ml|txt|conf)$/i, '')
    .replace(NAME_NOISE, '')
    .replace(/[|\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}
