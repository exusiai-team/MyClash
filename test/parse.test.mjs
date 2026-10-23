import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, parseUri, mergeSubscriptions, sumUserinfo, parseUserinfo, isExpired, detectAirportName, extractRate, dumpYaml, GROUP_NAME } from '../src/parse.js';
import fs from 'node:fs';
import { TEST_URLS, patchScript } from '../scripts/sync-scripts.mjs';
import vm from 'node:vm';
import * as yaml from 'js-yaml';

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

test('subscription-userinfo 解析与到期判断', () => {
  assert.deepEqual(parseUserinfo('upload=1; download=2.5; total=10;expire=200'), { upload: 1, download: 2.5, total: 10, expire: 200 });
  assert.deepEqual(parseUserinfo('total=abc; expire=-1; foo=3'), { upload: 0, download: 0, total: 0, expire: 0 });
  assert.equal(parseUserinfo(null), null);
  assert.equal(isExpired({ expire: 200 }, 200 * 1000), true);
  assert.equal(isExpired({ expire: 200 }, 199 * 1000), false);
  // 没有到期日、没有标头都不算到期
  assert.equal(isExpired({ expire: 0 }), false);
  assert.equal(isExpired(null), false);
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
  assert.deepEqual(tagged.proxies.map((p) => p.name), ['飞云 | 2x | 香港 01', '飞云 | 日本 01', '飞云 | 美国 01']);
  assert.equal(tagged.proxies[2]['dialer-proxy'], '飞云 | 2x | 香港 01');
  assert.equal(mergeSubscriptions([{ prefix: '', parsed }], { rateTag: true }).proxies[0].name, '2x | 香港 01');
  assert.equal(mergeSubscriptions([{ prefix: '飞云', parsed }]).proxies[0].name, '飞云 | 香港 01-2.0x');
});

function runScript(file, extra = []) {
  const ctx = vm.createContext({ console, structuredClone, URL });
  vm.runInContext(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), ctx);
  const proxies = ['🇺🇸 美国 01', '🇭🇰 香港 01', '🇯🇵 日本 01', '🇸🇬 新加坡 01', '🇹🇼 台湾 01'].map((name, i) => ({
    name, type: 'ss', server: `n${i}.example`, port: 1, cipher: 'aes-128-gcm', password: 'x',
  }));
  return vm.runInContext('main', ctx)({ proxies: [...proxies, ...extra] });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：分流组用 Bettbox 的测速网址，HuggingFace 不走 AI 组`, () => {
    const out = runScript(file);
    const groups = new Map(out['proxy-groups'].map((g) => [g.name, g]));
    // 有这个分流组时，测速网址必须是 TEST_URLS 里的
    for (const [name, url] of Object.entries(TEST_URLS)) {
      if (groups.has(name)) assert.equal(groups.get(name).url, url, name);
    }
    for (const name of ['Google', 'AI', 'Telegram', 'Steam']) assert.ok(groups.has(name), name);
    // 其他组维持上游的通用测速网址
    for (const name of ['默认代理', '香港', '漏网之鱼']) {
      assert.equal(groups.get(name).url, 'https://www.apple.com/library/test/success.html', name);
    }

    const hf = out.rules.indexOf('RULE-SET,huggingface,默认代理');
    assert.ok(hf !== -1 && hf < out.rules.indexOf('RULE-SET,ai,AI'));
    assert.match(out['rule-providers'].huggingface.url, /bett-rules@meta\/geo\/geosite\/huggingface\.mrs$/);
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：IPv6 节点组加进默认代理`, () => {
    const node = (name, server) => ({ name, type: 'ss', server, port: 1, cipher: 'aes-128-gcm', password: 'x' });
    const groups = (out) => new Map(out['proxy-groups'].map((g) => [g.name, g]));

    // 没有 IPv6 节点就不生成
    assert.ok(!groups(runScript(file)).has('IPv6'));

    const out = groups(runScript(file, [
      node('🇯🇵 日本 IPv6 02', 'jp6.example'),
      node('🇺🇸 美国 v6-03', 'us6.example'),
      node('🇭🇰 香港 02', '2001:db8::1'),
      node('🇸🇬 新加坡 dev602', 'sg.example'),
    ]));
    assert.deepEqual([...out.get('IPv6').proxies], ['🇯🇵 日本 IPv6 02', '🇺🇸 美国 v6-03', '🇭🇰 香港 02', 'IPv6-自动选择']);
    assert.equal(out.get('IPv6-自动选择').type, 'url-test');
    assert.ok(out.get('默认代理').proxies.includes('IPv6'));
    // 节点仍留在原本的地区组
    assert.ok(out.get('日本').proxies.includes('🇯🇵 日本 IPv6 02'));
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：日志级别 warning，本机 xray / sing-box 最先直连`, () => {
    const out = runScript(file);
    assert.equal(out['log-level'], 'warning');
    assert.deepEqual([...out.rules.slice(0, 4)], [
      'PROCESS-NAME,xray.exe,直连',
      'PROCESS-NAME,sing-box.exe,直连',
      'PROCESS-NAME,xray,直连',
      'PROCESS-NAME,sing-box,直连',
    ]);
  });
}

test('sync-scripts：上游改版找不到修改位置时报错', () => {
  assert.throws(() => patchScript('function main() {}', 'x.js'), /上游脚本可能改版/);
});

test('dumpYaml：输出读回来跟原本一样，节点一行一个，容易误判的字串加引号', () => {
  const config = {
    'mixed-port': 7890,
    ipv6: true,
    dns: { 'nameserver-policy': { 'geosite:cn': ['223.5.5.5'], '+.example.com': 'https://1.1.1.1/dns-query' }, empty: [] },
    proxies: [
      { name: '🇭🇰 飞云 | 2x | 香港 01', type: 'ss', server: 'hk.node', port: 443, 'ws-opts': { path: '/a', headers: { Host: 'x' } } },
      { name: 'a, b: {c} #d', type: 'trojan', password: 'yes' },
    ],
    'proxy-groups': [{ name: '默认代理', type: 'select', proxies: ['DIRECT', '🇭🇰 飞云 | 2x | 香港 01'] }],
    rules: ['RULE-SET,ai,AI', 'MATCH,默认代理'],
    words: ['true', 'No', 'on', 'null', '~', '', '1.5', '0x1F', '2001-12-14', '.inf', '<<', '- a', 'a\u2028b', 'a\u0085b', '\ufeff', 'line\nbreak'],
    nothing: null,
    skipped: undefined,
  };
  const out = dumpYaml(config);
  assert.deepEqual(yaml.load(out), JSON.parse(JSON.stringify(config)));
  assert.match(out, /^ {2}- \{name: "🇭🇰 飞云 \| 2x \| 香港 01", type: ss, server: hk\.node, port: 443, ws-opts: \{path: "\/a", headers: \{Host: x\}\}\}$/m);
  assert.match(out, /^ {2}- name: 默认代理$/m);
  assert.match(out, /^mixed-port: 7890$/m);
  assert.match(out, /^ {2}empty: \[\]$/m);
  assert.ok(!/[\u2028\u0085\ufeff]/.test(out), 'YAML 当成换行或不可打印的字符要转义');
  assert.ok(!out.includes('skipped'));
});
