import yaml from 'js-yaml';

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

/**
 * 合并多份订阅为一份可直接被 Script.js 覆写的 mihomo 设置（不含 proxy-providers）
 * @param {{ prefix: string, parsed: ReturnType<typeof parseSubscription> }[]} sources
 */
export function mergeSubscriptions(sources) {
  const proxies = [];
  const names = new Set();
  let dns = null;
  let hosts = null;

  for (const { prefix, parsed } of sources) {
    const renamed = new Map();
    for (const proxy of parsed.proxies) {
      const base = prefix ? `${prefix} | ${proxy.name}` : String(proxy.name);
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
  const body = yaml.dump(config, { lineWidth: -1, noRefs: true });
  return header ? `${header}\n${body}` : body;
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
