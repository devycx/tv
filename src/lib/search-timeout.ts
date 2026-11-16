/**
 * 搜索单源总死线（毫秒）：默认 3s，SEARCH_SOURCE_TIMEOUT_MS 可配（1s–60s）。
 *
 * 放在 lib 而不是 route.ts：Next 的路由文件只允许导出处理函数与固定配置项，
 * 多导出一个符号会让 `next build` 报 "not a valid Route export field"（`tsc --noEmit` 查不出来）。
 */
export function resolveSourceTimeoutMs(raw: string | undefined): number {
  const n = parseInt(raw || '3000', 10);
  if (!Number.isFinite(n)) return 3000;
  return Math.min(60000, Math.max(1000, n));
}
