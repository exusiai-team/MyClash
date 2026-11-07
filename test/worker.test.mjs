import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as yaml from 'js-yaml';
import worker from '../src/worker.js';
import { cacheKey } from '../src/cache.js';

// 内存版 KV，只实作 worker 用到的方法
function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (!v) return null;
      return type === 'json' ? JSON.parse(v.value) : v.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value, metadata: opts.metadata });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata }));
      return { keys, list_complete: true };
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url === '/yaml') {
      res.setHeader('subscription-userinfo', 'upload=1; download=2; total=100; expire=2000000000');
      res.end(
        yaml.dump({
          dns: { 'proxy-server-nameserver': ['https://223.5.5.5/dns-query'] },
          hosts: { 'hk.node': '10.0.0.1' },
          proxies: [
            { name: '🇭🇰 香港 01', type: 'ss', server: 'hk.node', port: 1, cipher: 'aes-128-gcm', password: 'x' },
            { name: '🇯🇵 日本 01', type: 'ss', server: 'jp.node', port: 1, cipher: 'aes-128-gcm', password: 'x' },
          ],
        }),
      );
    } else if (req.url === '/named') {
      res.setHeader('content-disposition', "attachment; filename*=UTF-8''%E9%A3%9E%E4%BA%91%E6%9C%BA%E5%9C%BA");
      res.end(yaml.dump({ proxies: [{ name: '新加坡 01', type: 'ss', server: 'sg.node', port: 1, cipher: 'aes-128-gcm', password: 'x' }] }));
    } else if (req.url === '/b64') {
      res.setHeader('subscription-userinfo', 'upload=10; download=20; total=50; expire=1900000000');
      res.end(b64(['trojan://pw@us.node:443#美国 01', 'trojan://pw@hk2.node:443#香港 01'].join('\n')));
    } else if (req.url === '/rate') {
      res.end(b64(['trojan://pw@hk.node:443#香港 01 [2x]', 'trojan://pw@jp.node:443#日本 01-1.0x'].join('\n')));
    } else if (req.url === '/expired') {
      // 2001-09-09 到期
      res.setHeader('subscription-userinfo', 'upload=5; download=5; total=10; expire=1000000000');
      res.setHeader('content-disposition', 'attachment; filename="OldCloud"');
      res.end(b64('trojan://pw@old.node:443#香港 过期'));
    } else if (req.url === '/used-up') {
      // 10 GB 用完，到期日还没到
      res.setHeader('subscription-userinfo', 'upload=0; download=10737418240; total=10737418240; expire=2000000000');
      res.end(b64('trojan://pw@used.node:443#日本 用完'));
    } else if (req.url === '/slow') {
      // 4 秒后才回应，比有旧缓存时的等待上限（2.5 秒）久
      setTimeout(() => res.end(b64('trojan://pw@new.node:443#新 01')), 4000);
    } else if (req.url === '/token-error') {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'fail', message: 'token is error', data: null }));
    } else if (req.url === '/blocked') {
      res.statusCode = 403;
      res.end('blocked');
    } else {
      res.statusCode = 500;
      res.end('boom');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function call(env, method, path, { body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`https://w.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
  );
}

test('/sub/<TOKEN>：rateTag 开启时在节点名称标注倍率', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const env = { SUB_STORE: memoryKv() };
  const { token, rateTag } = await (
    await call(env, 'POST', '/api/subs', {
      body: { name: 'r', rateTag: true, sources: [{ name: 'A', url: `http://127.0.0.1:${upstream.address().port}/rate` }] },
    })
  ).json();
  assert.equal(rateTag, true);
  const config = yaml.load(await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text());
  assert.deepEqual(config.proxies.map((p) => p.name), ['A | 2x | 香港 01', 'A | 日本 01']);
});

test('/sub/<TOKEN>：小火箭来拿时给小火箭的节点链接，其他客户端照旧给 YAML', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const env = { SUB_STORE: memoryKv() };
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const { token } = await (
    await call(env, 'POST', '/api/subs', { body: { name: 'r', prefixMode: 'none', sources: [{ url: `${base}/yaml` }, { url: `${base}/b64` }] } })
  ).json();
  const get = (ua, query = '') => worker.fetch(new Request(`https://w.test/sub/${token}${query}`, { headers: { 'User-Agent': ua } }), env);

  const res = await get('Shadowrocket/2070 CFNetwork/1410.0.3 Darwin/22.6.0');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(res.headers.get('subscription-userinfo'), 'upload=11; download=22; total=150; expire=1900000000');
  const uris = Buffer.from(await res.text(), 'base64').toString('utf8').split('\n');
  assert.match(uris[0], /^STATUS=/);
  assert.equal(uris.length, 5);
  assert.ok(uris[1].startsWith('ss://') && uris[1].endsWith('@hk.node:1#%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF%2001'), uris[1]);
  assert.ok(uris.includes('trojan://pw@us.node:443#%E7%BE%8E%E5%9B%BD%2001'));

  assert.ok(yaml.load(await (await get('clash.meta')).text()).proxies.length === 4);
  // 带 ?script= 的照样是覆写后的 YAML
  assert.ok(Array.isArray(yaml.load(await (await get('Shadowrocket/2070', '?script=lite')).text())['proxy-groups']));
});

test('/sub/<TOKEN>?script=：在服务端套用精简 / 全量覆写脚本', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (
    await call(env, 'POST', '/api/subs', {
      body: { name: '手机', prefixMode: 'none', sources: [{ url: `http://127.0.0.1:${upstream.address().port}/yaml` }] },
    })
  ).json();
  const get = (query) => worker.fetch(new Request(`https://w.test/sub/${token}${query}`), env);

  // 不带参数：维持不覆写，输出的是合法 YAML（JSON 格式）
  const plain = await get('');
  const plainText = await plain.text();
  assert.match(plainText, /^# MyClash 合并订阅：手机\n/);
  assert.deepEqual(yaml.load(plainText)['proxy-groups'].map((g) => g.name), ['节点选择']);
  assert.equal(plain.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('手机')}`);

  const groups = {};
  for (const [mode, label] of [['lite', '精简'], ['full', '全量']]) {
    const res = await get(`?script=${mode}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('手机')}`);
    assert.ok(res.headers.get('subscription-userinfo'));
    const body = await res.text();
    assert.match(body, new RegExp(`已套用${label}版覆写脚本`));
    assert.match(body, /^# \[S1\] 2 个节点$/m);
    const config = yaml.load(body);
    groups[mode] = config['proxy-groups'].map((g) => g.name);
    assert.ok(groups[mode].includes('默认代理'));
    assert.ok(config.proxies.some((p) => p.name.includes('香港')));
    assert.ok(config.rules.includes('RULE-SET,huggingface,默认代理'));
    // 订阅里没有台湾、美国节点：AI 组不设默认，由客户端退回第一项
    assert.equal(config['proxy-groups'].find((g) => g.name === 'AI')['default-selected'], undefined);
  }
  assert.ok(!groups.lite.includes('YouTube'));
  assert.ok(groups.full.includes('YouTube'));

  assert.equal((await get('?script=nope')).status, 400);
});

test('AI 链式代理：勾选的机场节点与整组直接挂上「AI链式代理」中转', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const env = { SUB_STORE: memoryKv() };
  const url = `http://127.0.0.1:${upstream.address().port}/yaml`;
  const res = await call(env, 'POST', '/api/subs', {
    body: { name: 'c', prefixMode: 'none', sources: [{ url, aiChain: ['🇯🇵 日本 01', '不存在'] }] },
  });
  const { token, sources } = await res.json();
  assert.deepEqual(sources[0].aiChain, ['🇯🇵 日本 01', '不存在']);

  const get = async (query) => (await worker.fetch(new Request(`https://w.test/sub/${token}${query}`), env)).text();
  // 不覆写：没有链式代理，也不会带出标记
  const plain = yaml.load(await get(''));
  assert.ok(!plain.proxies.some((p) => p['dialer-proxy'] || 'myclash-ai-chain' in p));

  const body = await get('?script=lite');
  assert.match(body, /^# AI 链式代理：1 个单独勾的节点，经「AI链式代理」组中转/m);
  const config = yaml.load(body);
  // 原节点直接挂中转，不复制；勾了但机场没有的节点不生效
  assert.ok(!config.proxies.some((p) => 'myclash-ai-chain' in p));
  assert.deepEqual(config.proxies.filter((p) => p['dialer-proxy']).map((p) => [p.server, p['dialer-proxy']]), [['jp.node', 'AI链式代理']]);
  const groups = new Map(config['proxy-groups'].map((g) => [g.name, g]));
  const jp = config.proxies.find((p) => p.server === 'jp.node').name;
  assert.equal(groups.get('AI').proxies[0], jp);
  assert.equal(groups.get('AI')['default-selected'], jp);
  assert.equal(groups.get('AI链式代理')['default-selected'], '香港');
  assert.equal(groups.get('AI链式代理').proxies.at(-1), '直连');

  // 整组：只收认得的地区组，按固定顺序；再保存一次不带就清掉
  const put = async (aiChainGroups) => (await call(env, 'PUT', `/api/subs/${token}`, {
    body: { name: 'c', prefixMode: 'none', aiChainGroups, sources: [{ url }] },
  })).json();
  assert.deepEqual((await put(['日本', '乱写', '台湾'])).aiChainGroups, ['台湾', '日本']);
  const grouped = await get('?script=lite');
  assert.match(grouped, /^# AI 链式代理：整组 台湾、日本，经「AI链式代理」组中转/m);
  const c2 = yaml.load(grouped);
  // 没有台湾节点，整组台湾略过；AI 默认选日本
  assert.equal(c2['proxy-groups'].find((g) => g.name === 'AI')['default-selected'], '日本');
  assert.equal(c2.proxies.find((p) => p.server === 'jp.node')['dialer-proxy'], 'AI链式代理');
  assert.ok(!('myclash-ai-chain-groups' in c2));
  assert.deepEqual((await put(undefined)).aiChainGroups, []);
});

test('/sub/<TOKEN>：浏览器网址栏打开时跳到管理页自动导入，「首页」按钮也带上 TOKEN', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (
    await call(env, 'POST', '/api/subs', { body: { name: '手机', sources: [{ url: `http://127.0.0.1:${upstream.address().port}/yaml` }] } })
  ).json();
  const browser = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
  const open = (query, headers) => worker.fetch(new Request(`https://w.test/sub/${token}${query}`, { headers }), env);

  const nav = await open('?script=full', browser);
  assert.equal(nav.status, 302);
  assert.equal(nav.headers.get('location'), `https://w.test/#import=${token}&script=full`);
  assert.equal((await open('', browser)).headers.get('location'), `https://w.test/#import=${token}`);

  // 客户端与管理页的 fetch 照常拿到配置
  const sub = await open('?script=lite', { Accept: '*/*' });
  assert.equal(sub.status, 200);
  assert.equal(sub.headers.get('profile-web-page-url'), `https://w.test/#import=${token}&script=lite`);
  assert.equal((await open('', {})).headers.get('profile-web-page-url'), `https://w.test/#import=${token}`);
});

test('POST /api/subs/lookup：一次查多个 TOKEN', async () => {
  const env = { SUB_STORE: memoryKv() };
  const create = async (name) => (await (await call(env, 'POST', '/api/subs', { body: { name, sources: [{ url: 'https://a.test' }] } })).json()).token;
  const a = await create('甲');
  const b = await create('乙');
  const gone = 'f'.repeat(32);

  const res = await call(env, 'POST', '/api/subs/lookup', { body: { tokens: [a, gone, 'not-a-token', b, a] } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).items.map((it) => [it.token, it.name]), [[a, '甲'], [b, '乙']]);

  assert.deepEqual(await (await call(env, 'POST', '/api/subs/lookup', { body: { tokens: [] } })).json(), { items: [] });
  assert.equal((await call(env, 'POST', '/api/subs/lookup', { body: { tokens: 'x' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/subs/lookup', { body: { tokens: Array(51).fill(a) } })).status, 400);
  assert.equal((await call(env, 'GET', '/api/subs/lookup')).status, 404);
});

test('没有管理密码也能用，且不提供列出全部订阅的 API', async () => {
  const env = { SUB_STORE: memoryKv() };
  assert.equal((await call(env, 'GET', '/api/subs')).status, 404);
  assert.equal((await call(env, 'GET', '/api/subs/' + '0'.repeat(32))).status, 404);
});

test('管理 API：添加 / 查找 / 编辑 / 换 TOKEN / 删除', async () => {
  const env = { SUB_STORE: memoryKv() };
  const bad = await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ url: 'ftp://a' }] } });
  assert.equal(bad.status, 400);

  const created = await (await call(env, 'POST', '/api/subs', { body: { name: '手机', sources: [{ name: 'A', url: 'https://a.test/s' }] } })).json();
  assert.match(created.token, /^[a-f0-9]{32}$/);

  const got = await (await call(env, 'GET', `/api/subs/${created.token}`)).json();
  assert.equal(got.name, '手机');
  assert.equal(got.sources.length, 1);

  const edited = await (await call(env, 'PUT', `/api/subs/${created.token}`, { body: { name: '电脑', sources: [{ url: 'https://b.test' }, { url: 'https://c.test' }] } })).json();
  assert.equal(edited.name, '电脑');
  assert.equal(edited.sources.length, 2);

  const rotated = await (await call(env, 'POST', `/api/subs/${created.token}/rotate`)).json();
  assert.notEqual(rotated.token, created.token);
  assert.equal((await call(env, 'GET', `/api/subs/${created.token}`)).status, 404);
  assert.equal((await call(env, 'GET', `/api/subs/${rotated.token}`)).status, 200);

  assert.equal((await call(env, 'DELETE', `/api/subs/${rotated.token}`)).status, 200);
  assert.equal(env.SUB_STORE.store.size, 0);
});

test('/sub/<TOKEN>：合并多个订阅，失败的跳过', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };

  const { token } = await (
    await call(env, 'POST', '/api/subs', {
      body: { name: '全部', sources: [{ name: 'A', url: `${base}/yaml` }, { url: `${base}/b64` }, { name: '坏掉', url: `${base}/fail` }] },
    })
  ).json();

  const res = await worker.fetch(new Request(`https://w.test/sub/${token}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('subscription-userinfo'), 'upload=11; download=22; total=150; expire=1900000000');
  assert.equal(res.headers.get('profile-web-page-url'), `https://w.test/#import=${token}`);
  const body = await res.text();
  assert.match(body, /\[坏掉\] 失败：HTTP 500/);
  const config = yaml.load(body);
  assert.deepEqual(
    config.proxies.map((p) => p.name),
    ['A | 🇭🇰 香港 01', 'A | 🇯🇵 日本 01', 'S2 | 美国 01', 'S2 | 香港 01'],
  );
  assert.deepEqual(config.hosts, { 'hk.node': '10.0.0.1' });
  assert.ok(config.dns['proxy-server-nameserver']);
  assert.ok(!body.includes(base), '不可回显订阅链接');

  assert.equal((await worker.fetch(new Request('https://w.test/sub/nope'), env)).status, 404);

  await call(env, 'PUT', `/api/subs/${token}`, { body: { name: '全部', sources: [{ url: `${base}/fail` }] } });
  assert.equal((await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).status, 502);
});

test('节点前缀三种模式：机场名称 / S1S2 / 不加', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const names = async (prefixMode) => {
    const { token } = await (
      await call(env, 'POST', '/api/subs', {
        body: { name: 'x', prefixMode, sources: [{ url: `${base}/named` }, { url: `${base}/b64` }, { name: '自定', url: `${base}/b64` }] },
      })
    ).json();
    const body = await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text();
    return { body, names: yaml.load(body).proxies.map((p) => p.name) };
  };

  const byName = await names('name');
  assert.deepEqual(byName.names, ['飞云 | 新加坡 01', 'S2 | 美国 01', 'S2 | 香港 01', '自定 | 美国 01', '自定 | 香港 01']);
  assert.match(byName.body, /\[飞云\] 1 个节点/);

  const byIndex = await names('index');
  assert.deepEqual(byIndex.names, ['S1 | 新加坡 01', 'S2 | 美国 01', 'S2 | 香港 01', '自定 | 美国 01', '自定 | 香港 01']);

  const none = await names('none');
  assert.deepEqual(none.names, ['新加坡 01', '美国 01', '香港 01', '美国 01 2', '香港 01 2']);
  assert.match(none.body, /\[飞云\] 1 个节点/);

  // 同一家机场两份订阅：第二份的简称加序号
  const { token: twice } = await (
    await call(env, 'POST', '/api/subs', { body: { name: 'z', prefixMode: 'name', sources: [{ url: `${base}/named` }, { url: `${base}/named` }] } })
  ).json();
  const twiceBody = await (await worker.fetch(new Request(`https://w.test/sub/${twice}`), env)).text();
  assert.deepEqual(yaml.load(twiceBody).proxies.map((p) => p.name), ['飞云 | 新加坡 01', '飞云2 | 新加坡 01']);
  assert.match(twiceBody, /\[飞云2\] 1 个节点/);

  const bad = await (await call(env, 'POST', '/api/subs', { body: { name: 'y', prefixMode: '??', sources: [{ url: base }] } })).json();
  assert.equal(bad.prefixMode, 'name');
});

test('直连失败时改用 GitHub Actions 代抓的缓存', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (
    await call(env, 'POST', '/api/subs', {
      body: { name: 'x', sources: [{ url: `${base}/blocked` }, { name: '没缓存', url: `${base}/fail` }] },
    })
  ).json();

  // 没有缓存：全部失败
  assert.equal((await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).status, 502);

  await env.SUB_STORE.put(
    await cacheKey(`${base}/blocked`),
    JSON.stringify({
      body: yaml.dump({ proxies: [{ name: '台湾 01', type: 'ss', server: 'tw.node', port: 1, cipher: 'aes-128-gcm', password: 'x' }] }),
      disposition: "attachment; filename*=UTF-8''%E5%90%B9%E9%9B%AA",
      userinfo: 'upload=1; download=1; total=10; expire=0',
      fetchedAt: Date.now() - 2 * 3600 * 1000,
    }),
  );
  const res = await worker.fetch(new Request(`https://w.test/sub/${token}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('subscription-userinfo'), 'upload=1; download=1; total=10; expire=0');
  const body = await res.text();
  assert.match(body, /\[吹雪\] 1 个节点（直连失败：HTTP 403，使用 2 小时前的缓存）/);
  assert.match(body, /\[没缓存\] 失败：HTTP 500/);
  assert.deepEqual(yaml.load(body).proxies.map((p) => p.name), ['吹雪 | 台湾 01']);
});

test('立即刷新缓存：触发 GitHub Actions，1 分钟内只能按一次', async (t) => {
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ url: 'https://a.test' }] } })).json();

  const noToken = await call(env, 'POST', `/api/subs/${token}/refresh`);
  assert.equal(noToken.status, 501);
  assert.match((await noToken.json()).error, /GITHUB_TOKEN/);

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  t.after(() => (globalThis.fetch = realFetch));

  Object.assign(env, { GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'me/repo' });
  assert.equal((await call(env, 'POST', '/api/subs/' + '0'.repeat(32) + '/refresh')).status, 404);
  assert.equal((await call(env, 'POST', `/api/subs/${token}/refresh`)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/me/repo/actions/workflows/refresh-cache.yml/dispatches');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ghp_x');
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });

  assert.equal((await call(env, 'POST', `/api/subs/${token}/refresh`)).status, 429);
  assert.equal(calls.length, 1);
});

test('覆写脚本同步状态：读最近一次执行与最后更新，存 5 分钟；立即同步要有 TOKEN，10 分钟限一次', async (t) => {
  const env = { SUB_STORE: memoryKv(), GITHUB_REPO: 'me/repo' };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/runs?')) {
      return Response.json({ workflow_runs: [{ status: 'completed', conclusion: 'failure', event: 'schedule', created_at: '2026-10-23T18:43:00Z', html_url: 'https://github.com/me/repo/actions/runs/1' }] });
    }
    if (String(url).includes('/commits?')) {
      return Response.json([{ html_url: 'https://github.com/me/repo/commit/abc', commit: { message: 'chore(script): 同步上游覆写脚本\n\n正文', committer: { date: '2026-10-22T18:44:00Z' } } }]);
    }
    return new Response(null, { status: 204 });
  };
  t.after(() => (globalThis.fetch = realFetch));

  const status = await (await call(env, 'GET', '/api/scripts')).json();
  assert.deepEqual(status, {
    run: { status: 'completed', conclusion: 'failure', event: 'schedule', createdAt: Date.parse('2026-10-23T18:43:00Z'), url: 'https://github.com/me/repo/actions/runs/1' },
    updated: { at: Date.parse('2026-10-22T18:44:00Z'), message: 'chore(script): 同步上游覆写脚本', url: 'https://github.com/me/repo/commit/abc' },
    canTrigger: false,
  });
  assert.equal(calls[0].url, 'https://api.github.com/repos/me/repo/actions/workflows/sync-scripts.yml/runs?per_page=1');
  assert.equal(calls[1].url, 'https://api.github.com/repos/me/repo/commits?sha=rules&path=script.js&per_page=1');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  // 第二次读 KV，不再打 GitHub
  await call(env, 'GET', '/api/scripts');
  assert.equal(calls.length, 2);

  const { token } = await (await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ url: 'https://a.test' }] } })).json();
  assert.equal((await call(env, 'POST', `/api/subs/${token}/sync-scripts`)).status, 501);
  env.GITHUB_TOKEN = 'ghp_x';
  assert.equal((await call(env, 'POST', '/api/subs/' + '0'.repeat(32) + '/sync-scripts')).status, 404);
  assert.equal((await call(env, 'POST', `/api/subs/${token}/sync-scripts`)).status, 200);
  assert.equal(calls[2].url, 'https://api.github.com/repos/me/repo/actions/workflows/sync-scripts.yml/dispatches');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer ghp_x');
  assert.equal((await call(env, 'POST', `/api/subs/${token}/sync-scripts`)).status, 429);
  assert.equal(calls.length, 3);
  // 触发后清掉缓存，下次重新读 GitHub
  assert.equal((await (await call(env, 'GET', '/api/scripts')).json()).canTrigger, true);
  assert.equal(calls.length, 5);
});

test('缓存键名是链接的 SHA-256，不含链接本身', async () => {
  const key = await cacheKey('https://a.test/sub?token=secret');
  assert.match(key, /^cache:[a-f0-9]{64}$/);
  assert.equal(key, await cacheKey('https://a.test/sub?token=secret'));
});

test('没有绑定 KV（预览版本）时给出明确提示', async () => {
  const res = await worker.fetch(new Request('https://w.test/sub/' + '0'.repeat(32)), {});
  assert.equal(res.status, 503);
  assert.match(await res.text(), /KV/);
});

test('/sub/<TOKEN>：到期或流量用完的机场自动屏蔽，不计入流量与到期日', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (
    await call(env, 'POST', '/api/subs', {
      body: { name: 'x', sources: [{ name: 'A', url: `${base}/yaml` }, { url: `${base}/expired` }, { name: '用完', url: `${base}/used-up` }] },
    })
  ).json();

  const res = await worker.fetch(new Request(`https://w.test/sub/${token}`), env);
  assert.equal(res.status, 200);
  // 只剩 A 的流量与到期日；屏蔽的机场若计入，客户端会把整个合并订阅显示成已到期或流量用完
  assert.equal(res.headers.get('subscription-userinfo'), 'upload=1; download=2; total=100; expire=2000000000');
  const body = await res.text();
  assert.match(body, /^# \[Old\] 已屏蔽：订阅已于 2001-09-09 到期$/m);
  assert.match(body, /^# \[用完\] 已屏蔽：流量已用完（10\.0 GB \/ 10\.0 GB）$/m);
  assert.deepEqual(yaml.load(body).proxies.map((p) => p.name), ['A | 🇭🇰 香港 01', 'A | 🇯🇵 日本 01']);

  // 依缓存判断到期也会屏蔽
  await env.SUB_STORE.put(
    await cacheKey(`${base}/blocked`),
    JSON.stringify({ body: b64('trojan://pw@c.node:443#C 01'), userinfo: 'expire=1000000000', fetchedAt: Date.now() - 3600 * 1000 }),
  );
  await call(env, 'PUT', `/api/subs/${token}`, { body: { name: 'x', sources: [{ name: 'B', url: `${base}/blocked` }, { url: `${base}/expired` }] } });
  const all = await worker.fetch(new Request(`https://w.test/sub/${token}`), env);
  assert.equal(all.status, 502);
  assert.match(await all.text(), /都已到期或流量用完/);
});

test('GET /api/subs/<TOKEN>/sources：每个机场的流量、到期日、是否屏蔽与节点', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const urls = ['/yaml', '/named', '/expired', '/fail', '/blocked', '/used-up'].map((p) => base + p);
  const { token } = await (await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: urls.map((url) => ({ url })) } })).json();
  const fetchedAt = Date.now() - 3600 * 1000;
  await env.SUB_STORE.put(
    await cacheKey(`${base}/blocked`),
    JSON.stringify({ body: 'x', userinfo: 'upload=1; download=1; total=10; expire=2100000000', fetchedAt }),
  );

  const res = await call(env, 'GET', `/api/subs/${token}/sources`);
  assert.equal(res.status, 200);
  const { checkedAt, sources } = await res.json();
  assert.ok(checkedAt > 0);
  assert.deepEqual(sources.map((s) => s.url), urls);
  const [plain, named, expired, failed, cached, usedUp] = sources;
  assert.deepEqual(plain.info, { upload: 1, download: 2, total: 100, expire: 2000000000 });
  assert.equal(plain.blocked, null);
  assert.equal(plain.error, null);
  assert.equal(named.name, '飞云');
  assert.equal(named.info, null);
  assert.equal(named.blocked, null);
  assert.equal(expired.name, 'Old');
  assert.equal(expired.blocked, 'expired');
  assert.equal(expired.info.expire, 1000000000);
  assert.equal(failed.error, 'HTTP 500');
  assert.equal(cached.error, null);
  assert.equal(cached.directError, 'HTTP 403');
  assert.equal(cached.cachedAt, fetchedAt);
  assert.equal(cached.info.expire, 2100000000);
  assert.equal(cached.blocked, null);
  assert.equal(usedUp.blocked, 'exhausted');

  assert.equal((await call(env, 'GET', `/api/subs/${'0'.repeat(32)}/sources`)).status, 404);
  assert.equal((await call(env, 'POST', `/api/subs/${token}/sources`)).status, 405);
});

test('节点筛选：手动排除与倍率门槛在合并时生效，/sources 列出原本的节点', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const created = await (
    await call(env, 'POST', '/api/subs', {
      body: {
        name: 'x',
        rateTag: true,
        excludeRate: 2,
        sources: [
          { name: 'A', url: `${base}/rate` },
          { name: 'B', url: `${base}/b64`, exclude: ['美国 01', '美国 01', 3, ''] },
        ],
      },
    })
  ).json();
  assert.equal(created.excludeRate, 2);
  assert.deepEqual(created.sources[1].exclude, ['美国 01']);
  assert.equal(created.sources[0].exclude, undefined);

  const res = await worker.fetch(new Request(`https://w.test/sub/${created.token}`), env);
  const body = await res.text();
  assert.deepEqual(yaml.load(body).proxies.map((p) => p.name), ['A | 日本 01', 'B | 香港 01']);
  assert.match(body, /^# \[A\] 1 个节点（已排除 1 个）$/m);
  assert.match(body, /^# \[B\] 1 个节点（已排除 1 个）$/m);
  // 被排除的节点所在机场照常计入流量
  assert.equal(res.headers.get('subscription-userinfo'), 'upload=10; download=20; total=50; expire=1900000000');

  const nodes = await (await call(env, 'GET', `/api/subs/${created.token}/sources`)).json();
  assert.deepEqual(nodes.sources.map((s) => s.nodes), [
    [{ name: '香港 01 [2x]', rate: 2 }, { name: '日本 01-1.0x', rate: 1 }],
    [{ name: '美国 01', rate: null }, { name: '香港 01', rate: null }],
  ]);
  assert.equal(nodes.sources[0].error, null);

  // 节点全被排除：该机场不计流量；全部机场都被排除时返回 502 并说明
  await call(env, 'PUT', `/api/subs/${created.token}`, {
    body: { name: 'x', excludeRate: 0.5, sources: [{ name: 'A', url: `${base}/rate` }, { name: 'B', url: `${base}/b64` }] },
  });
  const none = await worker.fetch(new Request(`https://w.test/sub/${created.token}`), env);
  assert.equal(none.status, 502);
  assert.match(await none.text(), /都被排除/);

  // 不合法的门槛当成不限
  for (const excludeRate of [0, -1, 'abc', '', null]) {
    const r = await (await call(env, 'PUT', `/api/subs/${created.token}`, { body: { name: 'x', excludeRate, sources: [{ url: base }] } })).json();
    assert.equal(r.excludeRate, null, String(excludeRate));
  }
  assert.equal((await call(env, 'GET', `/api/subs/${'0'.repeat(32)}/sources`)).status, 404);
});

test('节点筛选：每个机场可以单独设倍率门槛（跟随全局 / 不限 / 自定义）', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const { token, sources } = await (
    await call(env, 'POST', '/api/subs', {
      body: {
        name: 'x',
        excludeRate: 2,
        sources: [
          { name: '跟随', url: `${base}/rate` },
          { name: '不限', url: `${base}/rate`, excludeRate: null },
          { name: '自定', url: `${base}/rate`, excludeRate: 0.5 },
          { name: '无效', url: `${base}/rate`, excludeRate: 'abc' },
        ],
      },
    })
  ).json();
  assert.deepEqual(sources.map((s) => s.excludeRate), [undefined, null, 0.5, undefined]);
  assert.equal(Object.hasOwn(sources[0], 'excludeRate'), false);

  const body = await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text();
  assert.deepEqual(yaml.load(body).proxies.map((p) => p.name), [
    '跟随 | 日本 01-1.0x',
    '不限 | 香港 01 [2x]',
    '不限 | 日本 01-1.0x',
    '无效 | 日本 01-1.0x',
  ]);
  assert.match(body, /^# \[自定\] 0 个节点（已排除 2 个）$/m);
});

test('机场订阅缓存：30 分钟内直接用不连机场，抓成功就写回，refresh 重新连', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ name: 'A', url: `${base}/b64` }] } })).json();
  const key = await cacheKey(`${base}/b64`);

  // 第一次连机场，成功后写进缓存
  await worker.fetch(new Request(`https://w.test/sub/${token}`), env);
  await new Promise((r) => setTimeout(r, 10));
  const saved = JSON.parse(env.SUB_STORE.store.get(key).value);
  assert.ok(saved.body && saved.fetchedAt > Date.now() - 5000);
  assert.equal(saved.userinfo, 'upload=10; download=20; total=50; expire=1900000000');

  // 新鲜缓存：机场关了也照样拿得到，而且不标成缓存
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (...a) => { upstreamCalls++; return realFetch(...a); };
  t.after(() => (globalThis.fetch = realFetch));
  const body = await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text();
  assert.equal(upstreamCalls, 0);
  assert.match(body, /^# \[A\] 2 个节点$/m);
  const sources = (await (await call(env, 'GET', `/api/subs/${token}/sources`)).json()).sources;
  assert.equal(upstreamCalls, 0);
  assert.equal(sources[0].cachedAt, null);
  assert.equal(sources[0].fetchedAt, saved.fetchedAt);

  // 「重新检查」重新连机场
  await call(env, 'GET', `/api/subs/${token}/sources?refresh=1`);
  assert.equal(upstreamCalls, 1);
});

test('机场订阅缓存：机场太慢时先用旧缓存，背景抓完再写回；机场拒绝时附上原因', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const old = { body: b64('trojan://pw@old.node:443#旧 01'), userinfo: 'upload=1; download=1; total=10; expire=0', fetchedAt: Date.now() - 3600 * 1000 };
  await env.SUB_STORE.put(await cacheKey(`${base}/slow`), JSON.stringify(old));
  await env.SUB_STORE.put(await cacheKey(`${base}/token-error`), JSON.stringify(old));
  const { token } = await (
    await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ name: '慢', url: `${base}/slow` }, { name: '失效', url: `${base}/token-error` }] } })
  ).json();

  const started = Date.now();
  const body = await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text();
  assert.ok(Date.now() - started < 3500, '不等慢的机场');
  assert.match(body, /^# \[慢\] 1 个节点（直连失败：机场回应太慢，使用 1 小时前的缓存）$/m);
  assert.match(body, /^# \[失效\] 1 个节点（直连失败：HTTP 403：token is error，使用 1 小时前的缓存）$/m);
  assert.deepEqual(yaml.load(body).proxies.map((p) => p.name), ['慢 | 旧 01', '失效 | 旧 01']);

  // 背景抓完后缓存换成新的
  await new Promise((r) => setTimeout(r, 1800));
  const fresh = JSON.parse(env.SUB_STORE.store.get(await cacheKey(`${base}/slow`)).value);
  assert.match(Buffer.from(fresh.body, 'base64').toString(), /new\.node/);
});

test('机场订阅缓存：抓不到又没有缓存的机场 5 分钟内不再重抓，refresh 才重抓', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };
  const { token } = await (
    await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ name: 'A', url: `${base}/b64` }, { name: '坏', url: `${base}/token-error` }] } })
  ).json();
  const realFetch = globalThis.fetch;
  const hits = [];
  globalThis.fetch = async (url, init) => { hits.push(String(url)); return realFetch(url, init); };
  t.after(() => (globalThis.fetch = realFetch));

  const first = await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text();
  assert.match(first, /^# \[坏\] 失败：HTTP 403：token is error$/m);
  const second = await (await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).text();
  assert.match(second, /^# \[坏\] 失败：HTTP 403：token is error$/m);
  assert.equal(hits.filter((u) => u.endsWith('/token-error')).length, 1);

  await call(env, 'GET', `/api/subs/${token}/sources?refresh=1`);
  assert.equal(hits.filter((u) => u.endsWith('/token-error')).length, 2);
});
