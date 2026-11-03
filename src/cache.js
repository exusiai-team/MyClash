// 机场订阅缓存：每个机场一份，Worker 抓成功时写回（src/worker.js 的 loadSource），
// GitHub Actions 定时代抓（scripts/refresh-cache.mjs）也写进来，给屏蔽 Cloudflare 的机场用
export const CACHE_PREFIX = 'cache:';
// 缓存保留 3 天，太旧的节点就不再使用
export const CACHE_TTL_SECONDS = 3 * 24 * 3600;

/** KV 键名用订阅链接的 SHA-256，不把链接本身写进键名 */
export async function cacheKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return CACHE_PREFIX + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
