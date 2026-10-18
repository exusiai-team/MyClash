import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import yaml from 'js-yaml';
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
