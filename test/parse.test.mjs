import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, parseUri, mergeSubscriptions, sumUserinfo, detectAirportName, extractRate, GROUP_NAME } from '../src/parse.js';
import { patchScript } from '../src/script.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('YAML 订阅：取出 proxies / dns / hosts', () => {
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

test('base64 URI 列表：各协定解析', () => {
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

test('ss SIP002 旧格式（整段 base64）与 obfs 插件', () => {
  const old = parseUri('ss://' + b64('chacha20-ietf-poly1305:p@1.2.3.4:443') + '#n');
  assert.equal(old.server, '1.2.3.4');
  assert.equal(old.password, 'p');
  const obfs = parseUri('ss://' + b64('aes-128-gcm:p') + '@h.com:80/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dx.com#n');
  assert.deepEqual(obfs['plugin-opts'], { mode: 'http', host: 'x.com' });
});

test('合并：前缀、去重、dialer-proxy 改名、dns/hosts 合并', () => {
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

test('subscription-userinfo 加总', () => {
  assert.equal(
    sumUserinfo(['upload=1; download=2; total=10; expire=200', null, 'upload=3; download=4; total=20; expire=100', 'upload=0; download=0; total=5; expire=0']),
    'upload=4; download=6; total=35; expire=100',
  );
  assert.equal(sumUserinfo([null, undefined]), null);
});

test('识别机场名称：Content-Disposition 优先，其次域名', () => {
  assert.equal(detectAirportName("attachment; filename*=UTF-8''%E9%AD%94%E6%B3%95%E6%9C%BA%E5%9C%BA.yaml", 'https://x.com'), '魔法');
  assert.equal(detectAirportName('attachment; filename="FlyCloud"', 'https://x.com'), 'FlyCloud');
  assert.equal(detectAirportName('attachment; filename=Speed%20Net.yml', 'https://x.com'), 'Speed Net');
  assert.equal(detectAirportName(null, 'https://sub.abc-cloud.com/api/v1/client?token=1'), 'abc-cloud');
  assert.equal(detectAirportName(null, 'https://api.foo.co.uk/s'), 'foo');
  assert.equal(detectAirportName('attachment', 'http://1.2.3.4:8080/s'), '');
  assert.equal(detectAirportName("attachment; filename*=UTF-8''A%7CB", 'https://x.com'), 'A B');
});

test('倍率提取：常见写法与分隔符清理', () => {
  const cases = [
    ['🇺🇸 美国04-1.5x |4837', 1.5, '🇺🇸 美国04|4837'],
    ['🇹🇼 台湾01-1.0x |移联|家宽', 1, '🇹🇼 台湾01|移联|家宽'],
    ['台湾1|5倍率|勿跑大流量', 5, '台湾1|勿跑大流量'],
    ['2x专线-日本-1', 2, '专线-日本-1'],
    ['🇯🇵日本高速01|CTCU|0.5x', 0.5, '🇯🇵日本高速01|CTCU'],
    ['🇭🇰香港04|负载均衡x0.6', 0.6, '🇭🇰香港04|负载均衡'],
    ['🇭🇰Hong Kong｜下载推荐｜0.01X', 0.01, '🇭🇰Hong Kong｜下载推荐'],
    ['新加坡 (2倍)', 2, '新加坡'],
    ['[0.5x] 日本', 0.5, '日本'],
    ['倍率:3 韩国', 3, '韩国'],
    ['美国 ×1.5', 1.5, '美国'],
  ];
  for (const [name, rate, rest] of cases) assert.deepEqual(extractRate(name), { rate, rest }, name);
  for (const name of ['香港 01', 'Linux2 香港', '日本-4 (IPv6)', '剩余流量：2x', '套餐到期 x2']) {
    assert.deepEqual(extractRate(name), { rate: null, rest: name }, name);
  }
});

test('合并：rateTag 标注倍率，1 倍不标，dialer-proxy 跟着改名', () => {
  const parsed = {
    proxies: [
      { name: '香港 01-2.0x', type: 'ss' },
      { name: '日本 01-1.0x', type: 'ss' },
      { name: '美国 01', type: 'ss', 'dialer-proxy': '香港 01-2.0x' },
    ],
    dns: null,
    hosts: null,
    skipped: 0,
  };
  const tagged = mergeSubscriptions([{ prefix: '飞云', parsed }], { rateTag: true });
  assert.deepEqual(tagged.proxies.map((p) => p.name), ['飞云 | 2.0x | 香港 01', '飞云 | 日本 01', '飞云 | 美国 01']);
  assert.equal(tagged.proxies[2]['dialer-proxy'], '飞云 | 2.0x | 香港 01');
  assert.equal(mergeSubscriptions([{ prefix: '', parsed }], { rateTag: true }).proxies[0].name, '2.0x | 香港 01');
  assert.equal(mergeSubscriptions([{ prefix: '飞云', parsed }]).proxies[0].name, '飞云 | 香港 01-2.0x');
});

test('覆写脚本修补：用 huggingface 规则集把 HuggingFace 从 AI 组分出来', () => {
  const upstream = `function main(config) {
  return {
    'proxy-groups': [{ name: '默认代理' }, { name: 'AI' }],
    'rule-providers': { ai: { type: 'http', format: 'mrs', url: 'https://cdn.example/geo/geosite/category-ai-!cn.mrs', path: './ruleset/ai.mrs', 'path-in-bundle': 'geo/geosite/category-ai-!cn.mrs' } },
    rules: ['RULE-SET,google,Google', 'RULE-SET,ai,AI', 'MATCH,漏网之鱼'],
  };
}`;
  const out = new Function(`${patchScript(upstream)}; return main({});`)();
  assert.deepEqual(out.rules, ['RULE-SET,google,Google', 'RULE-SET,huggingface,默认代理', 'RULE-SET,ai,AI', 'MATCH,漏网之鱼']);
  assert.deepEqual(out['rule-providers'].huggingface, {
    type: 'http',
    format: 'mrs',
    url: 'https://cdn.example/geo/geosite/huggingface.mrs',
    path: './ruleset/huggingface.mrs',
    'path-in-bundle': 'geo/geosite/huggingface.mrs',
  });

  // AI 组没开时不动
  const noAi = new Function(`${patchScript("function main() { return { 'proxy-groups': [{ name: '默认代理' }], 'rule-providers': {}, rules: ['MATCH,x'] }; }")}; return main({});`)();
  assert.deepEqual(noAi.rules, ['MATCH,x']);
  assert.ok(!('huggingface' in noAi['rule-providers']));
  // 上游没有 main 时也不会让脚本报错
  assert.doesNotThrow(() => new Function(patchScript('const x = 1;'))());
});
