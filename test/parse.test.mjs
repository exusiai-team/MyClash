import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, parseUri, mergeSubscriptions, sumUserinfo, parseUserinfo, isExpired, isExhausted, detectAirportName, shortName, extractRate, filterProxies, dumpYaml, GROUP_NAME } from '../src/parse.js';
import fs from 'node:fs';
import { BASE_TEST_INTERVAL, BASE_TEST_URL, DIRECT_TEST_URL, REGION_TEST_URLS, SUKKA_RULESET_URL, TEST_URLS, patchScript } from '../scripts/sync-scripts.mjs';
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

test('解析：除了名称以外完全相同的节点只留第一个，dialer-proxy 改指保留的那个', () => {
  const node = (name, extra = {}) => ({ name, type: 'ss', server: 'a.example', port: 1, cipher: 'aes-128-gcm', password: 'x', ...extra });
  const text = yaml.dump({
    proxies: [
      node('剩余流量：100 GB'), // 信息节点复制了真节点的设置，不能顶掉后面的真节点
      node('新加坡 06'),
      { password: 'x', name: '新加坡 07', type: 'ss', port: 1, server: 'a.example', cipher: 'aes-128-gcm' }, // 键顺序不同也算重复
      node('新加坡 08', { port: 2 }),
      node('落地', { server: 'b.example', 'dialer-proxy': '新加坡 07' }),
    ],
  });
  const parsed = parseSubscription(text);
  assert.deepEqual(parsed.proxies.map((p) => p.name), ['剩余流量：100 GB', '新加坡 06', '新加坡 08', '落地']);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.proxies[3]['dialer-proxy'], '新加坡 06');
  assert.equal(parseSubscription(yaml.dump({ proxies: [node('a'), node('b', { port: 2 })] })).duplicates, 0);
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
  assert.equal(isExhausted({ upload: 4, download: 6, total: 10 }), true);
  assert.equal(isExhausted({ upload: 4, download: 5, total: 10 }), false);
  // 总流量为 0（不限或没提供）不算用完
  assert.equal(isExhausted({ upload: 4, download: 6, total: 0 }), false);
  assert.equal(isExhausted(null), false);
});

test('识别机场名称：Content-Disposition 优先，其次域名', () => {
  assert.equal(detectAirportName("attachment; filename*=UTF-8''%E9%AD%94%E6%B3%95%E6%9C%BA%E5%9C%BA.yaml", 'https://x.com'), '魔法');
  assert.equal(detectAirportName('attachment; filename="FlyCloud"', 'https://x.com'), 'Fly');
  assert.equal(detectAirportName('attachment; filename=Speed%20Net.yml', 'https://x.com'), 'Speed');
  assert.equal(detectAirportName(null, 'https://sub.abc-cloud.com/api/v1/client?token=1'), 'abc');
  assert.equal(detectAirportName(null, 'https://api.foo.co.uk/s'), 'foo');
  assert.equal(detectAirportName('attachment', 'http://1.2.3.4:8080/s'), '');
  assert.equal(detectAirportName("attachment; filename*=UTF-8''AB%7CCD", 'https://x.com'), 'AB');
  // 文件名缩完不剩东西就用域名，中文域名转回中文
  assert.equal(detectAirportName('attachment; filename="clash.yaml"', 'https://sub.mojie.net/s'), 'mojie');
  assert.equal(detectAirportName("attachment; filename*=UTF-8''%E6%B0%B8%E4%B9%85%E5%85%8D%E8%B4%B9%E4%BA%91", 'https://xn--9kqs1lo79d.cc/s'), '吹雪');
  assert.equal(detectAirportName(null, 'https://xn--bad!.cc/s'), '');
});

test('机场简称：常见机场名称按规则缩短', () => {
  const cases = {
    三毛机场: '三毛',
    MNKCloud: 'MNK',
    FSCloud: 'FS',
    FlyCloud: 'Fly',
    AmyTelecom: 'Amy',
    XCloud: '', // 只剩一个字母认不出，改用域名
    SingLink: 'Sing',
    nekocloud: 'neko',
    'Speed CloudNet': 'Speed', // 通用词叠在一起也去光
    'KTM Cloud': 'KTM',
    'iKuuu VPN': 'iKuuu',
    'BestVPN!': 'Best',
    'Nexitally 奶昔': '奶昔',
    'Kuromis 库洛米机场': '库洛米',
    'WestData西部数据 | 稳定高速': '西部数据',
    '大机场 Big Airport': 'Big',
    哆啦A梦VPN: '哆啦A梦',
    iceの小店: 'iceの小店',
    猫熊网络加速器: '猫熊',
    '一元机场 - 官网 yiyuan.xyz': '一元',
    '【良心云】官网': '良心',
    维云云: '维云',
    念云: '念云',
    '69云': '69云',
    最萌的云: '最萌的',
    '🚀八戒机场🚀': '八戒',
    '「宝可梦」机场订阅': '宝可梦',
    Nexitally_Clash: 'Nexitally',
    'mojie.net': 'mojie',
    '魔戒.net': '魔戒',
    'Just My Socks': 'Just My Socks',
    'A Very Long Airport Name Here': 'A Very Long',
    'HK Speed': 'Speed',
    'US Cloud': '',
    永久免费云: '',
    Clash_1700000000: '',
    a8f3c9e21b7d4f60aa12: '',
    x2Cloud: '',
  };
  for (const [raw, short] of Object.entries(cases)) assert.equal(shortName(raw), short, raw);
});

test('机场简称不会让覆写脚本把整个机场的节点误删或误分组', () => {
  const ctx = vm.createContext({ console, structuredClone, URL });
  vm.runInContext(fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8'), ctx);
  const filters = vm.runInContext('[excludeFilter, ...allRegionDefinitions.map((r) => r.regex)]', ctx);
  // 覆写脚本正则里的每个中文词都拿来组名称，加上英文的地区、倍率写法
  const words = filters.flatMap((re) => re.source.split('|')).filter((w) => /^[\p{Script=Han}]+$/u.test(w));
  const names = [
    ...words.flatMap((w) => [`${w}快云`, `快${w}云`, `Fast ${w}`]),
    ...['HK', 'HKG', 'JP', 'US', 'USA', 'SG', 'TW', 'Free', 'ISP', 'RES', 'expire', 'traffic', 'HongKong', 'Japan', 'America', 'United States', 'Singapore', 'Taiwan'].map((w) => `${w} Speed`),
    ...['x2', '2x', '0.5x', '3倍', 'x0'].map((w) => `Speed ${w}`),
    'Speed@tg', 'Speed http://a.com', 'speed.com',
  ];
  for (const raw of names) {
    const short = shortName(raw);
    for (const re of filters) assert.ok(!re.test(`${short} | 节点`), `${raw} → ${short} 命中 ${re}`);
  }
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

test('节点筛选：手动排除、倍率 ≥ 门槛不导入（没标的算 1 倍），dialer-proxy 断链的一并去掉', () => {
  const proxies = [
    { name: '香港 01 [2x]', type: 'ss' },
    { name: '日本 01-0.5x', type: 'ss' },
    { name: '美国 01', type: 'ss' },
    { name: '台湾 01', type: 'ss', 'dialer-proxy': '香港 01 [2x]' },
    { name: '台湾 02', type: 'ss', 'dialer-proxy': '台湾 01' },
    { name: '剩余流量：10 GB', type: 'ss' },
  ];
  const names = (opts) => filterProxies(proxies, opts).proxies.map((p) => p.name);
  assert.equal(filterProxies(proxies).proxies, proxies);
  assert.equal(filterProxies(proxies, { exclude: ['不存在'] }).excluded, 0);
  assert.deepEqual(names({ exclude: ['美国 01'] }), ['香港 01 [2x]', '日本 01-0.5x', '台湾 01', '台湾 02', '剩余流量：10 GB']);
  // 2x 被排除，经由它的台湾 01、台湾 02 也去掉
  const r = filterProxies(proxies, { excludeRate: 2 });
  assert.deepEqual(r.proxies.map((p) => p.name), ['日本 01-0.5x', '美国 01', '剩余流量：10 GB']);
  assert.equal(r.excluded, 3);
  assert.deepEqual(names({ excludeRate: 1 }), ['日本 01-0.5x']);
  assert.deepEqual(names({ excludeRate: 2.5 }), proxies.map((p) => p.name));
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
    for (const name of ['Google', 'AI', 'Apple', 'Telegram', 'Steam']) assert.ok(groups.has(name), name);
    assert.ok(out.rules.includes('RULE-SET,apple,Apple'));
    // 台湾地区组（含自动选择组）用 Claude 的测速网址
    assert.equal(REGION_TEST_URLS.台湾, TEST_URLS.AI);
    for (const name of ['台湾', '台湾-自动选择']) assert.equal(groups.get(name).url, TEST_URLS.AI, name);
    // 直连组用有 IPv6 地址的测速网址，「仅IPv6」才测得通
    assert.equal(groups.get('直连').url, DIRECT_TEST_URL);
    // 直连组默认选「IPv6优先」，其余直连节点都还在
    assert.equal(groups.get('直连').proxies[0], '🇨🇳 直连 | IPv6优先');
    assert.equal(groups.get('直连').proxies.length, 5);
    // 其他组用通用测速网址与间隔
    for (const name of ['默认代理', '香港', '香港-自动选择', '漏网之鱼']) {
      assert.equal(groups.get(name).url, BASE_TEST_URL, name);
      assert.equal(groups.get(name).interval, BASE_TEST_INTERVAL, name);
    }

    const hf = out.rules.indexOf('RULE-SET,huggingface,默认代理');
    assert.ok(hf !== -1 && hf < out.rules.indexOf('RULE-SET,ai,AI'));
    assert.match(out['rule-providers'].huggingface.url, /bett-rules@meta\/geo\/geosite\/huggingface\.mrs$/);
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：地区组与默认代理默认选自动选择`, () => {
    const node = (name) => ({ name, type: 'ss', server: 'a.example', port: 1, cipher: 'aes-128-gcm', password: 'x' });
    const out = runScript(file, [node('🇭🇰 香港 01'), node('🇯🇵 日本 01')]);
    const groups = new Map(out['proxy-groups'].map((g) => [g.name, g]));
    for (const name of ['香港', '日本']) assert.equal(groups.get(name).proxies[0], `${name}-自动选择`, name);
    assert.equal(groups.get('默认代理').proxies[0], '自动选择');
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
    assert.deepEqual([...out.get('IPv6').proxies], ['IPv6-自动选择', '🇯🇵 日本 IPv6 02', '🇺🇸 美国 v6-03', '🇭🇰 香港 02']);
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

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：代理服务器域名与 DNS 本身用两个 DoH 解析`, () => {
    const { dns } = runScript(file);
    const doh = ['https://223.5.5.5/dns-query#DIRECT', 'https://1.12.12.12/dns-query#DIRECT'];
    assert.deepEqual([...dns['default-nameserver']], doh);
    assert.deepEqual([...dns['proxy-server-nameserver']], doh);
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：AdBlock 组用 Sukka 的 Reject Base（默认 REJECT），不再用 category-ads 与 Fuck-you-MIUI`, () => {
    const out = runScript(file);
    const sukka = out['rule-providers']['sukka-reject'];
    assert.equal(sukka.format, 'mrs');
    assert.equal(sukka.behavior, 'domain');
    assert.equal(sukka.url, SUKKA_RULESET_URL);
    assert.ok(sukka.url.endsWith('@rules/rules/sukka-reject.mrs')); // 在 rules 分支，不在 main
    assert.ok(out.rules.includes('RULE-SET,sukka-reject,AdBlock'));
    for (const name of ['category-ads', 'fuck-you-miui']) {
      assert.ok(!(name in out['rule-providers']), name);
      assert.ok(!out.rules.includes(`RULE-SET,${name},AdBlock`), name);
    }
    assert.equal(out['proxy-groups'].find((g) => g.name === 'AdBlock').proxies[0], 'REJECT');
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：开启 sniffer，只拿域名匹配规则、不改目标地址`, () => {
    const { sniffer } = runScript(file);
    assert.equal(sniffer.enable, true);
    assert.equal(sniffer['parse-pure-ip'], true);
    assert.equal(sniffer['override-destination'], false);
    for (const p of ['HTTP', 'TLS', 'QUIC']) assert.ok(sniffer.sniff[p].ports.length > 0, p);
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：广告规则排在国内直连前面，分流规则里不重复`, () => {
    const { rules } = runScript(file);
    const ad = rules.indexOf('RULE-SET,sukka-reject,AdBlock');
    assert.ok(ad > rules.indexOf('RULE-SET,private,直连'));
    assert.ok(ad < rules.indexOf('RULE-SET,geolocation-cn,直连'));
    assert.equal(rules.filter((r) => r.endsWith(',AdBlock')).length, 1);
  });
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：自动选择组不选 HTTP / SOCKS5、高倍率与「勿跑大流量」节点，排除后会变空的组不加`, () => {
    const node = (name, type = 'ss') => ({ name, type, server: 'a.example', port: 1, cipher: 'aes-128-gcm', password: 'x' });
    const out = runScript(file, [
      node('🇭🇰 香港 02 | 2x'),
      node('🇭🇰 香港 03 | 1.5x'),
      node('🇭🇰 香港原生 勿跑大流量'),
      node('🇺🇸 美国 Free-http', 'http'),
      node('🇬🇧 英国 01 | 3x'),
    ]);
    const groups = new Map(out['proxy-groups'].map((g) => [g.name, g]));
    // 照 mihomo 的规则算出组里实际会被测速的节点（exclude-filter 的 (?i) 换成 JS 的 i 旗标）
    const types = new Map(out.proxies.map((p) => [p.name, p.type.toLowerCase()]));
    const effective = (name) => {
      const g = groups.get(name);
      const excludeTypes = (g['exclude-type'] ?? '').toLowerCase().split('|');
      const re = g['exclude-filter'] && new RegExp(g['exclude-filter'].replace(/^\(\?i\)/, ''), 'i');
      return g.proxies.filter((n) => !excludeTypes.includes(types.get(n)) && !re?.test(n));
    };
    for (const name of out['proxy-groups'].filter((g) => g.type === 'url-test').map((g) => g.name)) {
      assert.ok(effective(name).length > 0, `${name} 不能变空`);
    }
    const auto = effective('自动选择');
    assert.ok(auto.includes('🇭🇰 香港 03 | 1.5x'));
    for (const n of ['🇭🇰 香港 02 | 2x', '🇭🇰 香港原生 勿跑大流量', '🇺🇸 美国 Free-http', '🇬🇧 英国 01 | 3x']) assert.ok(!auto.includes(n), n);
    assert.deepEqual([...effective('香港-自动选择')], ['🇭🇰 香港 01', '🇭🇰 香港 03 | 1.5x']);
    // 高倍率组自己的自动选择不排除倍率
    assert.ok(effective('高倍率节点-自动选择').includes('🇭🇰 香港 02 | 2x'));
    // 只有高倍率节点的地区不加 exclude-filter，免得整组变空
    const ukOnly = [...groups.values()].filter((g) => g.type === 'url-test' && g.proxies.length === 1 && g.proxies[0] === '🇬🇧 英国 01 | 3x');
    assert.ok(ukOnly.length > 0);
    for (const g of ukOnly) assert.equal(g['exclude-filter'], undefined, g.name);
  });
}

test('小火箭配置：分流组与测速网址对标精简版', () => {
  const conf = fs.readFileSync(new URL('../public/shadowrocket.conf', import.meta.url), 'utf8');
  const section = (name) => conf.split(`[${name}]`)[1].split(/\n\[/)[0].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const groups = new Map(section('Proxy Group').map((l) => {
    const [name, value] = l.split(/ = (.*)/);
    return [name, value.split(',')];
  }));
  const lite = new Map(runScript('script.js')['proxy-groups'].map((g) => [g.name, g]));
  for (const name of ['Google', 'AI', 'Apple', 'Telegram', 'Steam', 'AdBlock', '默认代理', '漏网之鱼', '香港', '日本', '美国', '新加坡', '台湾']) {
    assert.ok(groups.has(name), name);
    assert.ok(lite.has(name), name);
  }
  for (const name of ['Google', 'AI', 'Apple', 'Telegram', 'Steam', '台湾']) {
    assert.ok(groups.get(name).includes(`url=${lite.get(name).url}`), name);
  }
  // 默认选择（第一项）同精简版
  assert.equal(groups.get('AI')[1], '台湾');
  for (const name of ['Google', 'Apple', 'Telegram', 'Steam']) assert.equal(groups.get(name)[1], '默认代理', name);
  assert.equal(groups.get('AdBlock')[1], 'REJECT');
  // 地区组同精简版分两层：手选组默认选「<地区>-自动选择」，手动选的节点重连后不会被测速改掉
  for (const name of ['香港', '日本', '美国', '新加坡', '台湾']) {
    assert.deepEqual(groups.get(name).slice(0, 2), ['select', `${name}-自动选择`], name);
    assert.equal(groups.get(`${name}-自动选择`)[0], 'url-test', name);
    assert.equal(lite.get(name).proxies[0], `${name}-自动选择`, name);
  }
  // 规则只能指向已定义的组或内置策略
  for (const rule of section('Rule')) {
    const policy = rule.split(',').at(-1);
    assert.ok(groups.has(policy) || ['DIRECT', 'REJECT'].includes(policy), rule);
  }
  assert.equal(section('Rule').at(-1), 'FINAL,漏网之鱼');
});

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
