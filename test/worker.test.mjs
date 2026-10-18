import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import yaml from 'js-yaml';
import worker from '../src/worker.js';

// 記憶體版 KV，只實作 worker 用到的方法
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
    } else if (req.url === '/b64') {
      res.setHeader('subscription-userinfo', 'upload=10; download=20; total=50; expire=1900000000');
      res.end(b64(['trojan://pw@us.node:443#美國 01', 'trojan://pw@hk2.node:443#香港 01'].join('\n')));
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

test('沒有管理密碼也能用，且不提供列出全部訂閱的 API', async () => {
  const env = { SUB_STORE: memoryKv() };
  assert.equal((await call(env, 'GET', '/api/ping')).status, 200);
  assert.equal((await call(env, 'GET', '/api/subs')).status, 404);
  assert.equal((await call(env, 'GET', '/api/subs/' + '0'.repeat(32))).status, 404);
  assert.equal((await worker.fetch(new Request('https://w.test/api/subs', { method: 'OPTIONS' }), env)).status, 204);
});

test('管理 API：新增 / 查詢 / 編輯 / 換 TOKEN / 刪除', async () => {
  const env = { SUB_STORE: memoryKv() };
  const bad = await call(env, 'POST', '/api/subs', { body: { name: 'x', sources: [{ url: 'ftp://a' }] } });
  assert.equal(bad.status, 400);

  const created = await (await call(env, 'POST', '/api/subs', { body: { name: '手機', sources: [{ name: 'A', url: 'https://a.test/s' }] } })).json();
  assert.match(created.token, /^[a-f0-9]{32}$/);

  const got = await (await call(env, 'GET', `/api/subs/${created.token}`)).json();
  assert.equal(got.name, '手機');
  assert.equal(got.sources.length, 1);

  const edited = await (await call(env, 'PUT', `/api/subs/${created.token}`, { body: { name: '電腦', sources: [{ url: 'https://b.test' }, { url: 'https://c.test' }] } })).json();
  assert.equal(edited.name, '電腦');
  assert.equal(edited.sources.length, 2);

  const rotated = await (await call(env, 'POST', `/api/subs/${created.token}/rotate`)).json();
  assert.notEqual(rotated.token, created.token);
  assert.equal((await call(env, 'GET', `/api/subs/${created.token}`)).status, 404);
  assert.equal((await call(env, 'GET', `/api/subs/${rotated.token}`)).status, 200);

  assert.equal((await call(env, 'DELETE', `/api/subs/${rotated.token}`)).status, 200);
  assert.equal(env.SUB_STORE.store.size, 0);
});

test('/sub/<TOKEN>：合併多個訂閱，失敗的跳過', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { SUB_STORE: memoryKv() };

  const { token } = await (
    await call(env, 'POST', '/api/subs', {
      body: { name: '全部', sources: [{ name: 'A', url: `${base}/yaml` }, { url: `${base}/b64` }, { name: '壞掉', url: `${base}/fail` }] },
    })
  ).json();

  const res = await worker.fetch(new Request(`https://w.test/sub/${token}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('subscription-userinfo'), 'upload=11; download=22; total=150; expire=1900000000');
  const body = await res.text();
  assert.match(body, /\[壞掉\] 失敗：HTTP 500/);
  const config = yaml.load(body);
  assert.deepEqual(
    config.proxies.map((p) => p.name),
    ['A | 🇭🇰 香港 01', 'A | 🇯🇵 日本 01', 'S2 | 美國 01', 'S2 | 香港 01'],
  );
  assert.deepEqual(config.hosts, { 'hk.node': '10.0.0.1' });
  assert.ok(config.dns['proxy-server-nameserver']);
  assert.ok(!body.includes(base), '不可回顯訂閱網址');

  assert.equal((await worker.fetch(new Request('https://w.test/sub/nope'), env)).status, 404);

  await call(env, 'PUT', `/api/subs/${token}`, { body: { name: '全部', sources: [{ url: `${base}/fail` }] } });
  assert.equal((await worker.fetch(new Request(`https://w.test/sub/${token}`), env)).status, 502);
});
