/**
 * 全局自适应批次控制。
 *
 * Cloudflare Workers 在 CPU/内存超限时返回 Error 1102（`Worker exceeded resource limits`）。
 * 客户端无法预知某次批量请求会不会撞上，只能在收到 1102 后**自动降低后续批次**：
 *
 * - 单例（模块级）共享给所有批量请求：测活、画质探测、源测试并发、搜索等；
 * - 每次 1102 把全局 scale 减半，最低 1/8（8 条批 → 4 → 2 → 1）；
 * - 只降不升：本会话内保持更低批次，刷新页面恢复满额，避免压力未消时来回抖动；
 * - 返回给各调用方的 batchLimit 至少 1，不会因为 floor 变成 0。
 *
 * 任何 API 收到 1102 都应调用 reportWorkerResourceLimit()；批量消费者用
 * getAdaptiveBatchLimit(base) 取当前可用批大小，并在每批开始前重新读取。
 */
const MIN_SCALE = 1 / 8;
let scale = 1;
const listeners = new Set<() => void>();

/** 当前全局缩放比例（1 = 正常）；供 UI/调试读取 */
export function getAdaptiveBatchScale(): number {
  return scale;
}

/** 按基准批大小计算当前可用批大小（至少 1） */
export function getAdaptiveBatchLimit(base: number): number {
  return Math.max(1, Math.floor(Math.max(1, base) * scale));
}

/**
 * 记录一次 Cloudflare 1102：全局批次减半。
 * 多个功能同时撞上 1102 会连续减半，这是有意的——压力越大批越小。
 */
export function reportWorkerResourceLimit(): void {
  if (scale <= MIN_SCALE) return;
  scale = Math.max(MIN_SCALE, scale / 2);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 订阅方异常不影响降批 */
    }
  }
}

/** 订阅“刚刚发生降批”（用于在直播测活工具栏提示用户） */
export function onAdaptiveBatchDownscale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 判断一个失败响应是不是 Cloudflare 1102。
 * 错误页通常是 HTTP 500 的 HTML；优先看 `cf-error-code` 头，再匹配错误页文案。
 */
export function isWorkerResourceLimit(status: number, body = '', headers?: Headers): boolean {
  if (headers?.get('cf-error-code') === '1102') return true;
  if (status !== 500 && status !== 503) return false;
  return /\b1102\b|Worker exceeded resource limits|exceeded resource limits/i.test(body);
}

/** 仅供单元测试：恢复初始状态并清空订阅 */
export function __resetAdaptiveBatchForTests(): void {
  scale = 1;
  listeners.clear();
}
