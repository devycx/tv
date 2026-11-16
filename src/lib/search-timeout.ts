/**
 * 搜索单源等待上限（毫秒）：默认 3s，部署者可用 SEARCH_SOURCE_TIMEOUT_MS 配，用户在设置里可覆盖。
 *
 * 放在 lib 而不是 route.ts：Next 的路由文件只允许导出处理函数与固定配置项，
 * 多导出一个符号会让 `next build` 报 "not a valid Route export field"（`tsc --noEmit` 查不出来）。
 */

export const DEFAULT_SOURCE_TIMEOUT_MS = 3000;
export const MIN_SOURCE_TIMEOUT_MS = 1000;
export const MAX_SOURCE_TIMEOUT_MS = 60000;

/** 收敛到允许区间；缺省/非数字返回 undefined，交给调用方兜底 */
export function normalizeSourceTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_SOURCE_TIMEOUT_MS, Math.max(MIN_SOURCE_TIMEOUT_MS, Math.round(n)));
}

/** 服务端默认值：部署者的 SEARCH_SOURCE_TIMEOUT_MS，缺省 3s */
export function resolveSourceTimeoutMs(raw: string | undefined): number {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) ? (normalizeSourceTimeoutMs(n) as number) : DEFAULT_SOURCE_TIMEOUT_MS;
}
