// best-ip 实测标签（家宽 / 机房、原生、落地国家、AI 可用性）：GitHub Actions 每天把合并后的订阅交给 best-ip 扫描
// （scripts/classify.mjs），结果精简后写进 KV 的 res:<TOKEN>；Worker 套用覆写脚本前按节点名称（对不上再按指纹）
// 把标签挂在 proxy[BESTIP_KEY] 上，覆写脚本据此细化分组（scripts/sync-scripts.mjs 的 addBestIp），输出的配置不会带着它。
// 接口说明见 docs/bestip-interface.md
export const RESULT_PREFIX = 'res:';
// 扫描停了（令牌失效、best-ip 下线）就让旧标签自然过期，不一直按几天前的落地分组
export const RESULT_TTL_SECONDS = 7 * 24 * 3600;
export const BESTIP_KEY = '_bestip';

/** 节点指纹：sha256(type|server|port|(uuid ?? password ?? "")) 的十六进制前 16 位，跟 best-ip 的算法一样；改名后靠它对上 */
export async function fingerprint(proxy) {
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const input = [proxy.type, proxy.server, proxy.port, proxy.uuid ?? proxy.password].map(str).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** best-ip 的扫描结果（schema_version 1）精简成写进 KV 的内容：只留测到落地 IP（status = ok）的节点与分组用得到的字段 */
export function compactResult(result) {
  if (result?.schema_version !== 1 || !Array.isArray(result.nodes)) throw new Error('best-ip 结果格式不对');
  const nodes = result.nodes
    .filter((n) => n?.status === 'ok' && typeof n.name === 'string')
    .map((n) => ({
      name: n.name,
      fingerprint: n.fingerprint,
      tag: {
        country_code: n.country_code ?? null,
        usage_type: n.usage_type ?? null,
        native: n.native ?? null,
        score: n.score ?? null,
        risk: n.risk ?? null,
        ai: n.ai ?? {},
        checked_at: n.checked_at ?? null,
      },
    }));
  return { scanId: result.scan_id, finishedAt: result.finished_at, nodeCount: result.node_count, nodes };
}

/**
 * 按名称（逐字一致）给节点挂上标签，对不上的再按指纹找（只用唯一的指纹，免得认错），返回挂了几个。
 * 直接改 proxies（合并后的节点，覆写脚本之前）
 */
export async function attachTags(proxies, stored) {
  const byName = new Map();
  const byPrint = new Map();
  for (const n of stored?.nodes ?? []) {
    if (!byName.has(n.name)) byName.set(n.name, n.tag);
    if (n.fingerprint) byPrint.set(n.fingerprint, byPrint.has(n.fingerprint) ? null : n.tag);
  }
  if (!byName.size) return 0;
  let count = 0;
  for (const [i, p] of proxies.entries()) {
    const tag = byName.get(p.name) ?? (byPrint.size ? byPrint.get(await fingerprint(p)) : null);
    if (!tag) continue;
    proxies[i] = { ...p, [BESTIP_KEY]: tag };
    count++;
  }
  return count;
}
