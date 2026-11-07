import { parseUserinfo } from './parse.js';

// 小火箭用：合并后的 mihomo 节点转成小火箭的节点链接（base64 编码的 URI 列表）。
// 小火箭能读 Clash YAML，但解析器是自己写的，reality-opts、client-fingerprint 等 mihomo 字段可能读不到，节点导入了却连不上。
// 写法照 Xboard 给小火箭的订阅（cedar2025/Xboard app/Protocols/Shadowrocket.php，很多机场用它），
// 但不加 tfo=1：蜂窝网络的 NAT 常丢 TFO 包，是小火箭超时、mihomo 正常的常见原因

/** 订阅请求来自小火箭（User-Agent 形如 Shadowrocket/2070 CFNetwork/...） */
export function isShadowrocket(userAgent) {
  return /shadowrocket/i.test(userAgent ?? '');
}

/**
 * @param {object[]} proxies 合并后的 mihomo 节点
 * @param {string | null} userinfo 合并后的 subscription-userinfo
 * @returns {{ body: string, skipped: number }} body 已 base64 编码；skipped 是小火箭不支持、略过的节点数
 */
export function toShadowrocket(proxies, userinfo) {
  const lines = [];
  const info = parseUserinfo(userinfo);
  // 小火箭把 STATUS= 这行显示在订阅上（流量、到期日）
  if (info) lines.push(`STATUS=↑:${gb(info.upload)}GB,↓:${gb(info.download)}GB,TOT:${gb(info.total)}GB💡Expires:${info.expire ? new Date(info.expire * 1000).toISOString().slice(0, 10) : 'N/A'}`);
  let skipped = 0;
  for (const p of proxies) {
    let uri = null;
    try {
      uri = BUILDERS[p.type]?.(p) ?? null;
    } catch {
      uri = null;
    }
    if (uri) lines.push(uri);
    else skipped++;
  }
  return { body: b64(lines.join('\n')), skipped };
}

const BUILDERS = {
  ss: buildSs,
  ssr: buildSsr,
  vmess: (p) => buildV2ray('vmess', p),
  vless: (p) => buildV2ray('vless', p),
  trojan: buildTrojan,
  hysteria: buildHysteria,
  hysteria2: buildHysteria2,
  tuic: buildTuic,
  anytls: buildAnytls,
  socks5: buildSocks,
};

function gb(bytes) {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64url(s) {
  return b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function addr(p) {
  const host = String(p.server);
  return `${host.includes(':') ? `[${host}]` : host}:${Number(p.port)}`;
}

// 去掉值为空的参数再组查询字串
function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  return q.toString().replace(/\+/g, '%20');
}

function withQuery(base, params, name) {
  const q = query(params);
  return `${base}${q ? `?${q}` : ''}${name === undefined ? '' : `#${encodeURIComponent(name)}`}`;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

// mihomo 的 up / down 可以是数字（Mbps）或「100 Mbps」这类字串
function mbps(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ss://BASE64URL(method:password)@host:port/?plugin=...#name（SIP002）
function buildSs(p) {
  if (!p.cipher || p.password === undefined) return null;
  let plugin;
  const o = p['plugin-opts'] ?? {};
  if (p.plugin === 'obfs') {
    plugin = `obfs-local;obfs=${o.mode ?? 'http'}${o.host ? `;obfs-host=${o.host}` : ''}`;
  } else if (p.plugin === 'v2ray-plugin') {
    plugin = ['v2ray-plugin', `mode=${o.mode ?? 'websocket'}`, o.tls && 'tls', o.host && `host=${o.host}`, o.path && `path=${o.path}`].filter(Boolean).join(';');
  } else if (p.plugin) {
    return null;
  }
  const base = `ss://${b64url(`${p.cipher}:${p.password}`)}@${addr(p)}${plugin ? '/' : ''}`;
  return withQuery(base, { plugin }, p.name);
}

// ssr://BASE64URL(host:port:protocol:method:obfs:BASE64URL(password)/?obfsparam=&protoparam=&remarks=)
function buildSsr(p) {
  const params = [
    p['obfs-param'] && `obfsparam=${b64url(p['obfs-param'])}`,
    p['protocol-param'] && `protoparam=${b64url(p['protocol-param'])}`,
    `remarks=${b64url(p.name)}`,
  ].filter(Boolean).join('&');
  return `ssr://${b64url(`${p.server}:${p.port}:${p.protocol}:${p.cipher}:${p.obfs}:${b64url(p.password)}/?${params}`)}`;
}

// 传输层参数（vmess、vless 共用；trojan 的 ws 写法不同，见 buildTrojan）
function transport(p) {
  switch (p.network) {
    case undefined:
    case 'tcp':
      return {};
    case 'ws': {
      const ws = p['ws-opts'] ?? {};
      return { obfs: 'websocket', path: ws.path, obfsParam: ws.headers?.Host };
    }
    case 'grpc':
      return { obfs: 'grpc', path: p['grpc-opts']?.['grpc-service-name'], host: p.servername ?? p.server };
    case 'h2': {
      const h2 = p['h2-opts'] ?? {};
      return { obfs: 'h2', path: h2.path, obfsParam: first(h2.host) };
    }
    case 'http': {
      const h = p['http-opts'] ?? {};
      return { obfs: 'http', path: first(h.path), obfsParam: first(h.headers?.Host) };
    }
    case 'httpupgrade': {
      const hu = p['ws-opts'] ?? {};
      return { obfs: 'httpupgrade', path: hu.path, obfsParam: hu.headers?.Host };
    }
    case 'xhttp': {
      const x = p['xhttp-opts'] ?? {};
      return { obfs: 'xhttp', path: x.path, obfsParam: x.host, mode: x.mode };
    }
    default:
      return null;
  }
}

// 小火箭自己的 vmess / vless 写法：vmess://BASE64(method:uuid@host:port)?remark=...&tls=1&obfs=websocket&...
function buildV2ray(type, p) {
  if (!p.uuid) return null;
  const net = transport(p);
  if (!net) return null;
  const reality = p['reality-opts'];
  const params = { remark: p.name };
  if (type === 'vmess') params.alterId = Number(p.alterId) || 0;
  if (p.flow) {
    const xtls = { 'xtls-rprx-direct': 1, 'xtls-rprx-vision': 2 }[p.flow];
    if (xtls === undefined) return null;
    params.xtls = xtls;
  }
  if (p.tls || reality) {
    params.tls = 1;
    if (reality) Object.assign(params, { sni: p.servername, pbk: reality['public-key'], sid: reality['short-id'] });
    else params.peer = p.servername;
    params.allowInsecure = p['skip-cert-verify'] === true;
    if (type === 'vless') params.fp = p['client-fingerprint'];
  }
  const method = type === 'vmess' ? (p.cipher || 'auto') : 'auto';
  return withQuery(`${type}://${b64(`${method}:${p.uuid}@${addr(p)}`)}`, { ...params, ...net });
}

// trojan://password@host:port?peer=...#name
function buildTrojan(p) {
  if (!p.password) return null;
  const reality = p['reality-opts'];
  const params = reality
    ? { security: 'reality', pbk: reality['public-key'], sid: reality['short-id'], sni: p.sni }
    : { peer: p.sni, allowInsecure: p['skip-cert-verify'] === true };
  switch (p.network) {
    case undefined:
    case 'tcp':
      break;
    case 'ws': {
      const ws = p['ws-opts'] ?? {};
      params.plugin = `obfs-local;obfs=websocket;obfs-host=${ws.headers?.Host ?? ''};obfs-uri=${ws.path ?? '/'}`;
      break;
    }
    case 'grpc':
      Object.assign(params, { obfs: 'grpc', path: p['grpc-opts']?.['grpc-service-name'] });
      break;
    default: {
      const net = transport(p);
      if (!net) return null;
      Object.assign(params, net);
    }
  }
  return withQuery(`trojan://${encodeURIComponent(p.password)}@${addr(p)}`, params, p.name);
}

// hysteria://host:port?auth=...&upmbps=...&downmbps=...#name（Hysteria 1）
function buildHysteria(p) {
  return withQuery(`hysteria://${addr(p)}`, {
    auth: p['auth-str'] ?? p.auth,
    upmbps: mbps(p.up),
    downmbps: mbps(p.down),
    protocol: p.protocol ?? 'udp',
    peer: p.sni,
    obfs: p.obfs && 'xplus',
    obfsParam: p.obfs,
    insecure: p['skip-cert-verify'] === true,
    mport: p.ports,
    alpn: [].concat(p.alpn ?? []).join(','),
  }, p.name);
}

// hysteria2://password@host:port?peer=...&obfs=salamander&obfs-password=...&mport=...#name
function buildHysteria2(p) {
  if (!p.password) return null;
  return withQuery(`hysteria2://${encodeURIComponent(p.password)}@${addr(p)}`, {
    peer: p.sni,
    insecure: p['skip-cert-verify'] === true,
    obfs: p.obfs,
    'obfs-password': p['obfs-password'],
    mport: p.ports,
    upmbps: mbps(p.up),
    downmbps: mbps(p.down),
  }, p.name);
}

// tuic://host:port?uuid=...&password=...&sni=...#name（v4 用 token）
function buildTuic(p) {
  if (!p.token && !p.uuid) return null;
  return withQuery(`tuic://${addr(p)}`, {
    ...(p.token ? { token: p.token } : { uuid: p.uuid, password: p.password }),
    sni: p.sni,
    alpn: [].concat(p.alpn ?? []).join(','),
    insecure: p['skip-cert-verify'] === true,
    congestion_control: p['congestion-controller'] ?? 'cubic',
  }, p.name);
}

// anytls://password@host:port?sni=...#name
function buildAnytls(p) {
  if (!p.password) return null;
  return withQuery(`anytls://${encodeURIComponent(p.password)}@${addr(p)}`, {
    sni: p.sni,
    insecure: p['skip-cert-verify'] === true,
  }, p.name);
}

// socks://BASE64(user:pass@host:port)#name；没有账号时只编码 host:port
function buildSocks(p) {
  if (p.tls) return null;
  const auth = p.username ? `${p.username}:${p.password ?? ''}@` : '';
  return withQuery(`socks://${b64(`${auth}${addr(p)}`)}`, {}, p.name);
}
