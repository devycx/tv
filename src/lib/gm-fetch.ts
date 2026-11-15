/**
 * 油猴「跨域助手」桥接。
 *
 * 脚本（Greasy Fork 508769）本身只做一件事：把 `GM_fetch` 挂到页面的 `window` 上。
 * `GM_fetch` 由 `GM.xmlHttpRequest` 实现，请求从扩展后台进程发出，因此：
 * - 不受 CORS 限制（源站没有 `Access-Control-Allow-Origin` 也能读响应体）；
 * - 不受混合内容限制（https 页面可以拉 http:// 的流）；
 * - 不带页面的 Referer / Cookie（对防盗链反而更宽松）。
 *
 * 站点必须**显式**改用它才有效果：脚本装上但页面不读 `GM_fetch`，表现和没装完全一样。
 *
 * 只在浏览器里检测：SSR 阶段没有 window，返回 null。
 */

export type GmFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

declare global {
  interface Window {
    /** 油猴「跨域助手」注入的函数；未安装/未匹配本站时为 undefined */
    GM_fetch?: GmFetch;
  }
}

/** 取当前页面的 GM_fetch；没有安装脚本或脚本没匹配本站时返回 null */
export function getGmFetch(): GmFetch | null {
  if (typeof window === 'undefined') return null;
  const fn = window.GM_fetch;
  return typeof fn === 'function' ? fn : null;
}

/** 是否已具备跨域助手能力（决定播放器/订阅是否走扩展请求） */
export function hasGmFetch(): boolean {
  return getGmFetch() !== null;
}
