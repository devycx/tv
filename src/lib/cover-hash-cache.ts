/**
 * 封面视觉指纹（dHash）的客户端缓存上限与淘汰。
 *
 * 存在浏览器 `localStorage` 的一个键里（`cover-visual-hashes-v3`），只放
 * `封面 URL → 16 位十六进制 dHash`，一条约 100 字节，**不是图片**。图片走
 * `/api/cover` 的 7 天私有 HTTP 缓存，不占这里。
 *
 * 为什么按「条数 + 字节」双预算，而不是只堆条数：
 * - localStorage 每个源只有约 5MB（Chrome/Edge/Safari 同量级），这个键要和
 *   设置、搜索历史等共用，不能把配额吃满；
 * - 单条大小取决于 URL 长度（图床域名长度差很多），只限条数时实际字节不可控。
 *
 * 100 条 20MB 这种量级在这里没有意义（20MB ≈ 20 万条），真要 MB 级存储得换
 * IndexedDB，而 dHash 只有 16 个字符，没必要。
 */

/** 最多保留多少条指纹 */
export const HASH_CACHE_MAX_ENTRIES = 3000;

/** 序列化后最多占多少字节（≈1.2MB，给 localStorage 的 5MB 配额留足余量） */
export const HASH_CACHE_MAX_BYTES = 1_200_000;

/** 一条 `"url":"hash",` 在 JSON 里的固定开销：两个引号 + 冒号 + 逗号 + 花括号余量 */
const ENTRY_OVERHEAD_BYTES = 6;

function entryBytes(url: string, hash: string): number {
  return url.length + hash.length + ENTRY_OVERHEAD_BYTES;
}

/** 估算这批条目序列化后的字节数（按 UTF-16 字符数近似，URL 基本是 ASCII） */
export function estimateHashCacheBytes(entries: Iterable<[string, string]>): number {
  let total = 2; // {}
  for (const [url, hash] of entries) total += entryBytes(url, hash);
  return total;
}

/**
 * 按 LRU 顺序（最旧在前）淘汰，直到同时满足条数/字节两个预算。
 * 至少保留 1 条：全丢掉等于下次搜索全部重算，没有意义。
 */
export function trimHashCache(entries: Iterable<[string, string]>): Array<[string, string]> {
  const kept = [...entries];
  if (kept.length === 0) return kept;

  let bytes = estimateHashCacheBytes(kept);
  while (kept.length > 1 && (kept.length > HASH_CACHE_MAX_ENTRIES || bytes > HASH_CACHE_MAX_BYTES)) {
    const [url, hash] = kept.shift() as [string, string];
    bytes -= entryBytes(url, hash);
  }
  return kept;
}
