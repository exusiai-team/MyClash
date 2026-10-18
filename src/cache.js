// 订阅缓存：GitHub Actions 定时代抓（scripts/refresh-cache.mjs）写进 KV，
// Worker 直连失败（例如机场屏蔽 Cloudflare）时改用这份缓存
export const CACHE_PREFIX = 'cache:';
// 缓存保留 3 天，太旧的节点就不再使用
export const CACHE_TTL_SECONDS = 3 * 24 * 3600;

/** KV 键名用订阅链接的 SHA-256，不把链接本身写进键名 */
export async function cacheKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return CACHE_PREFIX + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
