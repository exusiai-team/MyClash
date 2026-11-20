import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BESTIP_KEY, IPV6_ENTRY_KEY, attachTags, compactResult, fingerprint, ipv6Hosts, markIpv6Entry } from '../src/bestip.js';
import { addBestIp } from '../scripts/sync-scripts.mjs';

test('fingerprint：跟 best-ip 的参考值一致，缺的字段当空串，uuid 优先于 password', async () => {
  assert.equal(await fingerprint({ type: 'ss', server: '8.8.8.8', port: 8388, password: 'pw' }), '55303f6a971a8366');
  assert.equal(await fingerprint({ type: 'ss', server: '8.8.8.8', port: '8388', password: 'pw' }), '55303f6a971a8366');
  assert.equal(await fingerprint({ type: 'ss', server: '8.8.8.8', port: 8388, uuid: null, password: 'pw' }), '55303f6a971a8366');
  assert.notEqual(await fingerprint({ type: 'vless', server: 'a', port: 1, uuid: 'u', password: 'pw' }), await fingerprint({ type: 'vless', server: 'a', port: 1, password: 'pw' }));
  assert.match(await fingerprint({}), /^[0-9a-f]{16}$/);
});

test('compactResult：只留 status = ok 的节点与分组用得到的字段，格式不对就报错', () => {
  const node = (name, status, extra = {}) => ({
    name, index: 0, fingerprint: 'f', status, reason: null, checked_at: 't', reused: false, exit_ip: '203.0.113.7',
    country_code: 'JP', reg_country_code: 'US', usage_type: 'mobile', usage_votes: {}, native: false, asn: 1, as_org: 'x',
    score: 50, risk: { proxy: false }, ai: { openai: 'ok' }, same_exit: [], ...extra,
  });
  const out = compactResult({
    schema_version: 1, scan_id: 's', finished_at: 'f', node_count: 8,
    nodes: [
      node('a', 'ok'), node('b', 'failed'),
      // 重名的节点一个测到、一个没测到：分不出是哪个，不留名称，只靠指纹
      node('c', 'ok', { fingerprint: 'fc' }), node('c', 'failed'),
      node(null, 'ok', { fingerprint: null }), node(null, 'ok', { fingerprint: 'fn' }),
      // 「剩余流量」信息节点复制了 d 的设置（指纹相同，best-ip 跳过）：d 只按名称对，信息节点不会沾到 d 的标签
      node('d', 'ok', { fingerprint: 'fd' }), node('剩余流量：1 GB', 'skipped', { fingerprint: 'fd' }),
    ],
  });
  const tag = { country_code: 'JP', usage_type: 'mobile', native: false, score: 50, risk: { proxy: false }, ai: { openai: 'ok' }, exit_ipv6: null, checked_at: 't' };
  assert.deepEqual(out, {
    scanId: 's', finishedAt: 'f', nodeCount: 8,
    nodes: [
      { name: 'a', fingerprint: null, tag }, // 'f' 被 b、c 共用
      { name: null, fingerprint: 'fc', tag },
      { name: null, fingerprint: 'fn', tag },
      { name: 'd', fingerprint: null, tag },
    ],
  });
  assert.ok(!JSON.stringify(out).includes('203.0.113.7'));
  assert.throws(() => compactResult({ schema_version: 2, nodes: [] }), /格式不对/);
});

test('attachTags：名称优先，指纹只用唯一的，不改原本的节点物件', async () => {
  const a = { name: 'A', type: 'ss', server: 'a', port: 1, password: 'x' };
  const b = { name: 'B 新名', type: 'ss', server: 'b', port: 1, password: 'x' };
  const c = { name: 'C 新名', type: 'ss', server: 'c', port: 1, password: 'x' };
  const proxies = [a, b, c];
  const count = await attachTags(proxies, {
    nodes: [
      { name: 'A', fingerprint: 'x', tag: { n: 'a' } },
      { name: 'B', fingerprint: await fingerprint(b), tag: { n: 'b' } },
      // 两个节点指纹一样，认不出是哪个，不用
      { name: 'C1', fingerprint: await fingerprint(c), tag: { n: 'c1' } },
      { name: 'C2', fingerprint: await fingerprint(c), tag: { n: 'c2' } },
    ],
  });
  assert.equal(count, 2);
  assert.deepEqual(proxies.map((p) => p[BESTIP_KEY]?.n), ['a', 'b', undefined]);
  assert.ok(!(BESTIP_KEY in a));
  assert.equal(await attachTags(proxies, null), 0);
});

const node = (name, i, tag) => ({ name, type: 'ss', server: `n${i}.example`, port: 1, cipher: 'aes-128-gcm', password: 'x', ...(tag && { [BESTIP_KEY]: tag }) });

function run(file, proxies) {
  const ctx = vm.createContext({ console, structuredClone, URL });
  vm.runInContext(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), ctx);
  const out = vm.runInContext('main', ctx)({ proxies });
  return { out, groups: new Map(out['proxy-groups'].map((g) => [g.name, g.proxies])) };
}

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：按 best-ip 实测标签修正地区与家宽，不生成原生IP、AI实测可用组`, () => {
    const t = (country_code, usage_type, native = null, ai = {}) => ({ country_code, usage_type, native, ai });
    const { out, groups } = run(file, [
      node('🇺🇸 美国 01', 0),
      node('🇭🇰 香港 01', 1, t('HK', 'mobile', true, { openai: 'ok', claude: 'unknown' })),
      node('🇭🇰 香港 02', 2, t('KR', 'business', false, { openai: 'blocked' })),
      node('🇯🇵 日本 家宽 01', 3, t('JP', 'hosting', null, { openai: 'unknown' })),
      node('🇯🇵 日本 家宽 02', 4),
      node('🇸🇬 新加坡 01', 5, t(null, null)),
    ]);
    assert.ok(!out.proxies.some((p) => BESTIP_KEY in p));
    const members = (name) => [...(groups.get(name) ?? [])].slice(1);
    // 落地韩国的「香港 02」归到其他节点；实测国家缺的新加坡照名称
    assert.deepEqual(members('香港'), ['🇭🇰 香港 01']);
    assert.deepEqual(members('其他节点'), ['🇭🇰 香港 02']);
    assert.deepEqual(members('新加坡'), ['🇸🇬 新加坡 01']);
    // 家宽：移动网络算，名称写家宽但实测机房的拿掉，没标签的照名称
    assert.deepEqual(members('家宽节点'), ['🇭🇰 香港 01', '🇯🇵 日本 家宽 02']);
    // 不生成「原生IP」「AI实测可用」组
    assert.ok(!groups.has('原生IP') && !groups.has('AI实测可用'));

    // 没有任何标签时跟原本一样
    const plain = run(file, [node('🇭🇰 香港 02', 2), node('🇯🇵 日本 家宽 01', 3)]).groups;
    assert.deepEqual([...plain.get('香港')].slice(1), ['🇭🇰 香港 02']);
    assert.deepEqual([...plain.get('家宽节点')].slice(1), ['🇯🇵 日本 家宽 01']);
  });
}

test('addBestIp：上游改版找不到修改位置时报错', () => {
  assert.throws(() => addBestIp('function main() {}'), /上游脚本可能改版/);
});

for (const file of ['script.js', 'script-full.js']) {
  test(`覆写脚本 public/${file}：IPv6 组按 best-ip 实测的 IPv6 出口组成，IPv6 地址的连接走它`, () => {
    const t = (exit_ipv6) => ({ country_code: 'JP', usage_type: 'hosting', native: false, ai: {}, exit_ipv6 });
    const entry = { 'myclash-ipv6-entry': true };
    const { out, groups } = run(file, [
      { ...node('🇯🇵 日本 01', 0, t('2001:db8::1')), ...entry },
      // 实测带得出 IPv6，但本机连不了 IPv6（域名没有 IPv6 地址）：不算
      node('🇯🇵 日本 03', 4, t('2001:db8::3')),
      // 名称写了 IPv6，但实测带不出 IPv6：不算
      { ...node('🇯🇵 日本 IPv6', 1, t(null)), ...entry },
      // 没有标签：看名称
      { ...node('🇯🇵 日本 v6', 2), ...entry },
      node('🇯🇵 日本 02', 3, t(null)),
    ]);
    assert.deepEqual([...groups.get('IPv6')].slice(1), ['🇯🇵 日本 01', '🇯🇵 日本 v6']);
    assert.deepEqual([...out.proxies].filter((p) => p.type !== 'direct' && p['ip-version'] === 'ipv6').map((p) => p.name), ['🇯🇵 日本 01', '🇯🇵 日本 v6']);
    const rule = out.rules.indexOf('IP-CIDR6,::/0,IPv6,no-resolve');
    assert.ok(rule > out.rules.indexOf('RULE-SET,cn_ip,直连') && rule === out.rules.length - 2);
    // 没有 IPv6 组就不加这条规则
    const none = run(file, [node('🇯🇵 日本 02', 3, t(null))]).out;
    assert.ok(!none['proxy-groups'].some((g) => g.name === 'IPv6'));
    assert.ok(!none.rules.some((r) => r.startsWith('IP-CIDR6,::/0')));
  });
}

test('ipv6Hosts / markIpv6Entry：只查域名、去重，查到 AAAA 的打标记', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    const name = new URL(url).searchParams.get('name');
    asked.push(name);
    assert.equal(new URL(url).searchParams.get('type'), '28');
    const subnet = new URL(url).searchParams.get('edns_client_subnet');
    const v6 = { Status: 0, Answer: [{ type: 5 }, { type: 28 }] };
    const v4 = { Status: 0, Answer: [{ type: 5 }] };
    // mixed.example 只在不带子网时有 IPv6 地址（按地区给不同地址）
    return { json: async () => ({ 'v6.example': v6, 'mixed.example': subnet ? v4 : v6, 'bad.example': null }[name] ?? v4) };
  };
  const proxies = [
    { name: 'a', server: 'v6.example' }, { name: 'b', server: 'v6.example' }, { name: 'c', server: 'v4.example' },
    { name: 'd', server: '203.0.113.1' }, { name: 'e', server: '2001:db8::1' }, { name: 'f', server: 'bad.example' },
    { name: 'g', server: 'mixed.example' },
  ];
  const hosts = await ipv6Hosts(proxies, { fetchImpl });
  assert.deepEqual(hosts, ['v6.example']);
  // 有 IPv6 地址就不再换视角查；没有的各视角都查一次
  // 每个视角都要有 IPv6 地址：有的要查完四个视角，一个视角没有就不再查；查询全失败的当没有
  assert.deepEqual([...new Set(asked)].sort(), ['bad.example', 'mixed.example', 'v4.example', 'v6.example']);
  assert.equal(asked.filter((h) => h === 'v6.example').length, 4);
  assert.equal(asked.filter((h) => h === 'v4.example').length, 1);
  assert.equal(asked.filter((h) => h === 'mixed.example').length, 2);
  const copy = proxies.map((p) => ({ ...p }));
  assert.equal(markIpv6Entry(copy, hosts), 2);
  assert.deepEqual(copy.filter((p) => p[IPV6_ENTRY_KEY]).map((p) => p.name), ['a', 'b']);
  assert.equal(markIpv6Entry(copy, undefined), 0);
});
