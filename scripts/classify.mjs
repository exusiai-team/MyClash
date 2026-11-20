// GitHub Actions 每天执行：把每个合并订阅（不覆写的原始节点）交给 best-ip 实测落地标签，
// 精简后写进 KV 的 res:<TOKEN>，Worker 套用覆写脚本时按它细化分组（src/bestip.js）。接口说明见 docs/bestip-interface.md。
// best-ip 同一个令牌同时只跑一个扫描，所以一个订阅扫完再交下一个。扫描失败时取 best-ip 上这个订阅最近一次成功的结果兜底。
// 订阅内容直接内联交给 best-ip，不把带 TOKEN 的订阅链接交出去；日志只印序号与数量，不印 TOKEN 与节点。
import { readFile } from 'node:fs/promises';
import { RESULT_PREFIX, RESULT_TTL_SECONDS, compactResult, ipv6Hosts } from '../src/bestip.js';
import { parseSubscription } from '../src/parse.js';
import { hasToken, openKv, cf } from './cloudflare.mjs';

const BESTIP_URL = (process.env.BESTIP_URL || 'https://best-ip.silverwolfx.workers.dev').replace(/\/+$/, '');
const { BESTIP_SERVICE_TOKEN: SERVICE_TOKEN, MYCLASH_URL, GITHUB_RUN_ID } = process.env;
const FETCH_UA = 'clash.meta';
// 节点指纹不变、20 小时内测过的直接复用，每天只重测有变化的节点；
// 手动执行时可以改（BESTIP_REUSE_HOURS，例如 best-ip 结果加了新字段后设 0 全部重测一次）
const REUSE_HOURS = Number(process.env.BESTIP_REUSE_HOURS || 20);
const MAX_YAML_BYTES = 5 * 1024 * 1024;
const POLL_MS = 20 * 1000;
// 300 个节点约 5 分钟；best-ip 的网页扫描与 api 扫描排队执行，多留些时间
const WAIT_MS = 45 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bestip(path, init = {}) {
  const res = await fetch(BESTIP_URL + path, {
    ...init,
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, ...init.headers },
    signal: AbortSignal.timeout(60 * 1000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Worker 的网址：设了 MYCLASH_URL 就用它，否则按 wrangler.jsonc 的 Worker 名称与账号的 workers.dev 子域名拼出来
async function workerUrl(accountId) {
  if (MYCLASH_URL) return MYCLASH_URL.replace(/\/+$/, '');
  const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const name = config.match(/"name":\s*"([^"]+)"/)?.[1];
  const { result } = await (await cf(`/accounts/${accountId}/workers/subdomain`)).json();
  if (!name || !result?.subdomain) throw new Error('拼不出 Worker 网址，请在 Actions 的 Variables 设置 MYCLASH_URL');
  return `https://${name}.${result.subdomain}.workers.dev`;
}

async function waitScan(scanId) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { status, body } = await bestip(`/api/v1/classify/${scanId}`);
    if (status !== 200) throw new Error(`查询扫描状态失败：HTTP ${status}`);
    if (body.status === 'done' || body.status === 'failed') return body;
    if (Date.now() > deadline) return { ...body, status: 'failed', error: 'myclash_wait_timeout' };
    await sleep(POLL_MS);
  }
}

/** 交一次扫描并等它结束，返回结果（schema_version 1）；失败返回 null。别的 label 的扫描在跑时先等它跑完再交 */
async function scan(yamlText, label, requestId, log) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { status, body } = await bestip('/api/v1/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: attempt === 1 ? requestId : `${requestId}-${attempt}`,
        label,
        subscription_yaml: yamlText,
        profile: 'classify',
        reuse_hours: REUSE_HOURS,
      }),
    });
    if (status !== 200 && status !== 202) {
      log(`提交失败：HTTP ${status} ${body?.error ?? ''}`);
      return null;
    }
    const busy = body.deduplicated && body.label !== label;
    const done = await waitScan(body.scan_id);
    if (busy) {
      log(`best-ip 正在跑别的扫描（${body.scan_id}），等它结束后重新提交`);
      continue;
    }
    if (done.status !== 'done') {
      log(`扫描 ${body.scan_id} 失败：${done.error}`);
      return null;
    }
    const result = await bestip(`/api/v1/classify/${body.scan_id}/result`);
    if (result.status !== 200) {
      log(`取结果失败：HTTP ${result.status}`);
      return null;
    }
    return result.body;
  }
  log('best-ip 一直有别的扫描在跑，放弃这次');
  return null;
}

async function classify(token, workerBase, log) {
  const label = `myclash:${token.slice(0, 8)}`;
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  let result = null;
  const res = await fetch(`${workerBase}/sub/${token}`, { headers: { 'User-Agent': FETCH_UA }, signal: AbortSignal.timeout(60 * 1000) }).catch(
    (err) => ({ ok: false, status: err?.name ?? 'error' }),
  );
  const yamlText = res.ok ? await res.text() : null;
  if (!yamlText) log(`取合并订阅失败：HTTP ${res.status}`);
  else if (Buffer.byteLength(yamlText) > MAX_YAML_BYTES) log('合并订阅超过 5 MB，best-ip 不收');
  else result = await scan(yamlText, label, `myclash-${token.slice(0, 8)}-${day}-${GITHUB_RUN_ID || 'local'}`, log);

  if (!result) {
    const latest = await bestip(`/api/v1/classify/latest?label=${encodeURIComponent(label)}`);
    if (latest.status !== 200) {
      log(`也没有以前的结果可用（HTTP ${latest.status}），这次不更新`);
      return null;
    }
    log(`改用最近一次成功的结果（${latest.body.finished_at}）`);
    result = latest.body;
  }
  if (result.label !== label) throw new Error(`best-ip 回传的结果属于别的订阅（${result.label}）`);
  const compact = compactResult(result);
  // 本机能用 IPv6 连上的节点：server 域名有 IPv6 地址的（覆写脚本的「IPv6」组只收这些）
  if (yamlText) {
    compact.ipv6Hosts = await ipv6Hosts(parseSubscription(yamlText).proxies);
    log(`${compact.ipv6Hosts.length} 个节点域名有 IPv6 地址`);
  }
  return compact;
}

async function main() {
  if (!SERVICE_TOKEN) {
    console.log('::notice::没有设置 BESTIP_SERVICE_TOKEN，跳过 best-ip 实测（设置方法见 README）');
    return;
  }
  if (!hasToken) {
    console.log('::notice::没有设置 CLOUDFLARE_API_TOKEN，跳过 best-ip 实测（设置方法见 README）');
    return;
  }
  const health = await bestip('/api/v1/health');
  if (health.status !== 200) throw new Error(`best-ip 不可用：HTTP ${health.status} ${health.body?.error ?? ''}（检查 BESTIP_SERVICE_TOKEN）`);

  const kv = await openKv();
  const records = await kv.records();
  const workerBase = await workerUrl(kv.accountId);
  let updated = 0;
  for (const [i, { token }] of records.entries()) {
    const log = (msg) => console.log(`订阅 ${i + 1}/${records.length}：${msg}`);
    try {
      const compact = await classify(token, workerBase, log);
      if (!compact) continue;
      await kv.put([{ key: RESULT_PREFIX + token, value: JSON.stringify(compact), expiration_ttl: RESULT_TTL_SECONDS }]);
      log(`${compact.nodes.length} / ${compact.nodeCount} 个节点有标签（扫描 ${compact.scanId}）`);
      updated++;
    } catch (err) {
      console.log(`::warning::订阅 ${i + 1}/${records.length}：${err.message}`);
    }
  }
  console.log(`${records.length} 个合并订阅，更新了 ${updated} 个的实测标签`);
  if (records.length && !updated) throw new Error('一个订阅的实测标签都没更新');
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
