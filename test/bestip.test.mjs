import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BESTIP_KEY, attachTags, compactResult, fingerprint } from '../src/bestip.js';
import { AI_OK_GROUP, NATIVE_GROUP, addBestIp } from '../scripts/sync-scripts.mjs';

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
  const tag = { country_code: 'JP', usage_type: 'mobile', native: false, score: 50, risk: { proxy: false }, ai: { openai: 'ok' }, checked_at: 't' };
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
  test(`覆写脚本 public/${file}：按 best-ip 实测标签修正地区与家宽，新增原生IP、AI实测可用组`, () => {
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
    assert.deepEqual(members(NATIVE_GROUP), ['🇭🇰 香港 01']);
    assert.deepEqual(members(AI_OK_GROUP), ['🇭🇰 香港 01']);
    // 新组跟地区组一样可以在分流组里选
    assert.ok(groups.get('AI').includes(AI_OK_GROUP));

    // 没有任何标签时跟原本一样，不生成新组
    const plain = run(file, [node('🇭🇰 香港 02', 2), node('🇯🇵 日本 家宽 01', 3)]).groups;
    assert.deepEqual([...plain.get('香港')].slice(1), ['🇭🇰 香港 02']);
    assert.deepEqual([...plain.get('家宽节点')].slice(1), ['🇯🇵 日本 家宽 01']);
    assert.ok(!plain.has(NATIVE_GROUP) && !plain.has(AI_OK_GROUP));
  });
}

test('addBestIp：上游改版找不到修改位置时报错', () => {
  assert.throws(() => addBestIp('function main() {}'), /上游脚本可能改版/);
});
