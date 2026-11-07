import test from 'node:test';
import assert from 'node:assert/strict';
import { isShadowrocket, toShadowrocket } from '../src/rocket.js';

const decode = (s) => Buffer.from(s, 'base64').toString('utf8');
const lines = (proxies, userinfo = null) => decode(toShadowrocket(proxies, userinfo).body).split('\n');
const one = (proxy) => {
  const { body, skipped } = toShadowrocket([proxy], null);
  assert.equal(skipped, 0);
  return decode(body);
};
// 小火箭自己的 vmess / vless 写法：主体 base64，参数在 ? 后面
const v2ray = (uri) => {
  const [, scheme, main, q] = uri.match(/^(\w+):\/\/([^?]+)\?(.*)$/);
  return { scheme, main: decode(main), params: Object.fromEntries(new URLSearchParams(q)) };
};

test('isShadowrocket：认 User-Agent', () => {
  assert.ok(isShadowrocket('Shadowrocket/2070 CFNetwork/1410.0.3 Darwin/22.6.0 iPhone14,5'));
  assert.ok(!isShadowrocket('clash.meta'));
  assert.ok(!isShadowrocket(null));
});

test('toShadowrocket：STATUS 行显示流量与到期日，不支持的节点略过', () => {
  const { body, skipped } = toShadowrocket(
    [
      { name: 'wg', type: 'wireguard', server: 'a', port: 1 },
      { name: 'ss 01', type: 'ss', server: 'a.node', port: 8388, cipher: 'aes-128-gcm', password: 'pw' },
    ],
    'upload=1073741824; download=2147483648; total=107374182400; expire=2000000000',
  );
  assert.equal(skipped, 1);
  assert.deepEqual(decode(body).split('\n'), [
    'STATUS=↑:1GB,↓:2GB,TOT:100GB💡Expires:2033-05-18',
    `ss://${Buffer.from('aes-128-gcm:pw').toString('base64url')}@a.node:8388#ss%2001`,
  ]);
  assert.equal(lines([]).length, 1);
});

test('toShadowrocket：ss 插件、trojan ws、hysteria2，不加 tfo', () => {
  assert.equal(
    one({ name: 'o', type: 'ss', server: 'h', port: 1, cipher: 'aes-256-gcm', password: 'p', plugin: 'obfs', 'plugin-opts': { mode: 'tls', host: 'x.com' } }),
    `ss://${Buffer.from('aes-256-gcm:p').toString('base64url')}@h:1/?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dx.com#o`,
  );
  assert.equal(
    one({ name: '美国 01', type: 'trojan', server: 'us.node', port: 443, password: 'p@ss', sni: 's.com', network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'w.com' } } }),
    'trojan://p%40ss@us.node:443?peer=s.com&plugin=obfs-local%3Bobfs%3Dwebsocket%3Bobfs-host%3Dw.com%3Bobfs-uri%3D%2Fws#%E7%BE%8E%E5%9B%BD%2001',
  );
  assert.equal(
    one({ name: 'hy', type: 'hysteria2', server: 'h', port: 443, password: 'p', sni: 's', obfs: 'salamander', 'obfs-password': 'o', ports: '20000-30000', up: '50 Mbps', 'skip-cert-verify': true }),
    'hysteria2://p@h:443?peer=s&insecure=1&obfs=salamander&obfs-password=o&mport=20000-30000&upmbps=50#hy',
  );
  const all = lines([
    { name: 't', type: 'trojan', server: 'h', port: 1, password: 'p' },
    { name: 'v', type: 'vless', server: 'h', port: 1, uuid: 'u', tls: true },
    { name: 'm', type: 'vmess', server: 'h', port: 1, uuid: 'u', cipher: 'auto' },
  ]);
  for (const l of all) assert.ok(!/tfo/.test(l), l);
});

test('toShadowrocket：vless reality + vision、vmess ws tls 用小火箭自己的写法', () => {
  const vless = v2ray(one({
    name: '台湾 01', type: 'vless', server: 'tw.node', port: 443, uuid: 'uuid-1', tls: true, flow: 'xtls-rprx-vision',
    servername: 'www.apple.com', 'client-fingerprint': 'chrome', 'reality-opts': { 'public-key': 'PBK', 'short-id': 'ab' },
  }));
  assert.equal(vless.scheme, 'vless');
  assert.equal(vless.main, 'auto:uuid-1@tw.node:443');
  assert.deepEqual(vless.params, { remark: '台湾 01', xtls: '2', tls: '1', sni: 'www.apple.com', pbk: 'PBK', sid: 'ab', fp: 'chrome' });

  const vmess = v2ray(one({
    name: '香港 01', type: 'vmess', server: 'hk.node', port: 443, uuid: 'uuid-2', alterId: 0, cipher: 'auto', tls: true,
    servername: 'hk.com', network: 'ws', 'ws-opts': { path: '/v', headers: { Host: 'hk.com' } },
  }));
  assert.equal(vmess.main, 'auto:uuid-2@hk.node:443');
  assert.deepEqual(vmess.params, { remark: '香港 01', alterId: '0', tls: '1', peer: 'hk.com', obfs: 'websocket', path: '/v', obfsParam: 'hk.com' });

  const grpc = v2ray(one({ name: 'g', type: 'vless', server: 'h', port: 1, uuid: 'u', tls: true, servername: 's', network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'svc' } }));
  assert.equal(grpc.params.obfs, 'grpc');
  assert.equal(grpc.params.path, 'svc');
  assert.equal(grpc.params.host, 's');
});

test('toShadowrocket：tuic、anytls、socks5、IPv6 地址', () => {
  assert.equal(
    one({ name: 'tu', type: 'tuic', server: 'h', port: 1, uuid: 'u', password: 'p', sni: 's', alpn: ['h3'], 'congestion-controller': 'bbr' }),
    'tuic://h:1?uuid=u&password=p&sni=s&alpn=h3&congestion_control=bbr#tu',
  );
  assert.equal(one({ name: 'a', type: 'anytls', server: '2001:db8::1', port: 443, password: 'p', sni: 's' }), 'anytls://p@[2001:db8::1]:443?sni=s#a');
  assert.equal(one({ name: 's', type: 'socks5', server: 'h', port: 1080, username: 'u', password: 'p' }), `socks://${Buffer.from('u:p@h:1080').toString('base64')}#s`);
});
