/**
 * 播放页/直播页接管窗口标题的判断（纯逻辑，便于单测）。
 *
 * 为什么要「判断」而不是无脑写：Next 15 在生产构建里会把 head 的 `<title>`
 * 用 RSC 流里的 metadata 重建一次，把标题覆盖回默认值；我们因此挂了个
 * MutationObserver 补写。但补写不能抢别的路由的标题——只有当前标题还是
 * 「空的 / 默认标题」时才写，别的页面写了自己的标题就停手。
 */
export function shouldApplyDocumentTitle(
  current: string,
  desired: string,
  fallback: string
): boolean {
  if (!desired) return false;
  if (current === desired) return false;
  return current === '' || current === fallback;
}
