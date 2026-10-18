import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, parseUri, mergeSubscriptions, sumUserinfo, GROUP_NAME } from '../src/parse.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('YAML 訂閱：取出 proxies / dns / hosts', () => {
  const r = parseSubscription(`
dns:
  proxy-server-nameserver: [https://1.1.1.1/dns-query]
hosts:
  node.example: 1.2.3.4
proxies:
  - { name: 香港 01, type: ss, server: a.com, port: 1, cipher: aes-128-gcm, password: x }
  - { bad: true }
`);
  assert.equal(r.proxies.length, 1);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.hosts, { 'node.example': '1.2.3.4' });
  assert.ok(r.dns['proxy-server-nameserver']);
});

test('base64 URI 列表：各協定解析', () => {
  const vmess = 'vmess://' + b64(JSON.stringify({ ps: '日本 01', add: 'v.com', port: '443', id: 'uuid-1', aid: '0', net: 'ws', path: '/ws', host: 'h.com', tls: 'tls', sni: 's.com' }));
  const list = [
    'ss://' + b64('aes-256-gcm:pass') + '@ss.com:8388#%E9%A6%99%E6%B8%AF%2001',
    vmess,
    'vless://uuid-2@vl.com:443?security=reality&sni=www.apple.com&pbk=PK&sid=ab&fp=chrome&type=grpc&serviceName=g&flow=xtls-rprx-vision#US%2001',
    'trojan://pw@tr.com:443?sni=t.com&allowInsecure=1&type=ws&path=%2Fp#SG',
    'hysteria2://auth@hy.com:8443?sni=h.com&insecure=1&obfs=salamander&obfs-password=op#TW',
    'tuic://unsupported@x.com:1#x',
  ].join('\n');
  const r = parseSubscription(b64(list));
  assert.equal(r.proxies.length, 5);
  assert.equal(r.skipped, 1);
  const [ss, vm, vl, tr, hy] = r.proxies;
  assert.deepEqual(ss, { name: '香港 01', server: 'ss.com', port: 8388, type: 'ss', cipher: 'aes-256-gcm', password: 'pass', udp: true });
  assert.equal(vm.network, 'ws');
  assert.deepEqual(vm['ws-opts'], { path: '/ws', headers: { Host: 'h.com' } });
  assert.equal(vm.servername, 's.com');
  assert.equal(vl.flow, 'xtls-rprx-vision');
  assert.deepEqual(vl['reality-opts'], { 'public-key': 'PK', 'short-id': 'ab' });
  assert.deepEqual(vl['grpc-opts'], { 'grpc-service-name': 'g' });
  assert.equal(tr['skip-cert-verify'], true);
  assert.equal(tr.sni, 't.com');
  assert.equal(hy.obfs, 'salamander');
  assert.equal(hy['obfs-password'], 'op');
});

test('ss SIP002 舊格式（整段 base64）與 obfs 外掛', () => {
  const old = parseUri('ss://' + b64('chacha20-ietf-poly1305:p@1.2.3.4:443') + '#n');
  assert.equal(old.server, '1.2.3.4');
  assert.equal(old.password, 'p');
  const obfs = parseUri('ss://' + b64('aes-128-gcm:p') + '@h.com:80/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dx.com#n');
  assert.deepEqual(obfs['plugin-opts'], { mode: 'http', host: 'x.com' });
});

test('合併：前綴、去重、dialer-proxy 改名、dns/hosts 合併', () => {
  const a = { proxies: [{ name: 'HK', type: 'ss' }, { name: 'HK', type: 'ss' }, { name: 'chain', type: 'ss', 'dialer-proxy': 'HK' }], dns: { 'proxy-server-nameserver': ['1.1.1.1'], 'nameserver-policy': { a: 'x' } }, hosts: { a: '1' }, skipped: 0 };
  const b = { proxies: [{ name: 'HK', type: 'ss' }], dns: { 'proxy-server-nameserver': ['8.8.8.8'], 'nameserver-policy': { b: 'y' } }, hosts: { b: '2' }, skipped: 0 };
  const c = mergeSubscriptions([{ prefix: 'S1', parsed: a }, { prefix: 'S2', parsed: b }]);
  assert.deepEqual(c.proxies.map((p) => p.name), ['S1 | HK', 'S1 | HK 2', 'S1 | chain', 'S2 | HK']);
  assert.equal(c.proxies[2]['dialer-proxy'], 'S1 | HK 2');
  assert.deepEqual(c.dns['proxy-server-nameserver'], ['1.1.1.1']);
  assert.deepEqual(c.dns['nameserver-policy'], { a: 'x', b: 'y' });
  assert.deepEqual(c.hosts, { a: '1', b: '2' });
  assert.equal(c['proxy-groups'][0].name, GROUP_NAME);
  assert.equal(c['proxy-groups'][0].proxies.length, 4);
  assert.ok(!('proxy-providers' in c));
});

test('subscription-userinfo 加總', () => {
  assert.equal(
    sumUserinfo(['upload=1; download=2; total=10; expire=200', null, 'upload=3; download=4; total=20; expire=100', 'upload=0; download=0; total=5; expire=0']),
    'upload=4; download=6; total=35; expire=100',
  );
  assert.equal(sumUserinfo([null, undefined]), null);
});
