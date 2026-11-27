/**
 * 播放器全屏降级链（点播 player-shell 与直播 live-player 共用）。
 *
 * ArtPlayer 自带的 `fullscreen` 按钮只有两条路：
 *  1. 容器 Fullscreen API（screenfull.isEnabled：桌面 / Android Chrome / iPad）；
 *  2. iOS 的 `video.webkitEnterFullscreen()`（`webkitSupportsFullscreen`）。
 * 两条路都不可用或失败时（微信/QQ 等国产内核、部分 WKWebView 与 iOS + MSE 场景），
 * 点击「全屏」毫无反应，也不会自动降级。
 *
 * 这里统一接管全屏切换，按「容器原生全屏 → iOS video 原生全屏 → 网页全屏」降级，
 * 保证按钮在任何手机浏览器上都有响应；图标随三种形态同步。
 */

type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  /** iOS：true 表示当前处于 video 原生全屏（iPhone 上不产生 fullscreenElement） */
  webkitDisplayingFullscreen?: boolean;
};

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitPlayerElement = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** 全屏链路需要的最小播放器面：ArtPlayer 实例天然满足 */
export interface FullscreenPlayerLike {
  video: HTMLVideoElement | null;
  template: { $player: HTMLDivElement | null };
  fullscreenWeb: boolean;
  /** 库自身的容器全屏访问器：容器退出失败时的兜底（桌面快捷键路径仍在用） */
  fullscreen?: boolean;
}

/** 图标随状态同步需要的最小事件面：ArtPlayer 实例满足 */
interface EventfulPlayer {
  on(name: string, fn: (...args: unknown[]) => unknown): unknown;
  off(name: string, fn: (...args: unknown[]) => unknown): unknown;
}

/** iOS：video 元素正在原生全屏 */
export function isVideoNativeFullscreen(video?: HTMLVideoElement | null): boolean {
  const v = video as WebkitVideo | null | undefined;
  return Boolean(v && v.webkitDisplayingFullscreen);
}

/** 容器（播放器根节点）正在原生全屏 */
export function isContainerFullscreen(): boolean {
  const doc = document as WebkitDocument;
  return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
}

/** 播放器此刻是否处于任一形态的全屏（容器 / iOS video / 网页全屏） */
export function isPlayerFullscreen(art?: FullscreenPlayerLike | null): boolean {
  return (
    isContainerFullscreen() ||
    isVideoNativeFullscreen(art?.video) ||
    Boolean(art?.fullscreenWeb)
  );
}

/**
 * 全屏切换降级链。
 *
 * @param onFallbackToWeb 容器与 iOS video 全屏都不可用、被迫降级到网页全屏时回调
 *   （组件用来给一句「当前浏览器不支持全屏，已切换网页全屏」的提示）
 */
export async function togglePlayerFullscreen(
  art: FullscreenPlayerLike,
  onFallbackToWeb?: () => void
): Promise<void> {
  const video = art.video as WebkitVideo | null;
  const $player = art.template?.$player as WebkitPlayerElement | null | undefined;

  // —— 退出 ——
  if (isVideoNativeFullscreen(video)) {
    try {
      video?.webkitExitFullscreen?.();
    } catch {
      /* 忽略 */
    }
    return;
  }
  if (isContainerFullscreen()) {
    try {
      const doc = document as WebkitDocument;
      if (doc.exitFullscreen) await doc.exitFullscreen();
      else await doc.webkitExitFullscreen?.();
    } catch {
      // 退出失败交回库的退出路径兜底（桌面 F 快捷键走 art.fullscreen 仍然可用）
      try {
        art.fullscreen = false;
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  // 网页全屏兜底态：先退回页面内嵌，避免容器全屏叠在网页全屏上
  if (art.fullscreenWeb) {
    art.fullscreenWeb = false;
    return;
  }

  // —— 进入 ——
  // 1) 容器原生全屏（桌面 / Android Chrome / iPad）。与 ArtPlayer 的 screenfull.isEnabled
  //    同口径：document 上有 exitFullscreen 变体才算可用——iPhone Safari 上
  //    div.webkitRequestFullscreen 存在但无效，不能只看方法在不在。
  //    两个进入方法必须真实存在才尝试：环境残缺时 `await undefined` 会把
  //    「什么都没做」当成成功，按钮就死了。
  const requestFullscreenFn =
    $player?.requestFullscreen ?? ($player as WebkitPlayerElement | undefined)?.webkitRequestFullscreen;
  const containerSupported = Boolean(
    (document as WebkitDocument).exitFullscreen ||
      (document as WebkitDocument).webkitExitFullscreen
  );
  if (containerSupported && requestFullscreenFn) {
    try {
      await requestFullscreenFn.call($player);
      return;
    } catch {
      /* 继续降级 */
    }
  }
  // 2) iOS iPhone：只允许 <video> 原生全屏（MSE/ManagedMediaSource 播放同样适用）
  if (typeof video?.webkitEnterFullscreen === 'function') {
    try {
      video.webkitEnterFullscreen();
      return;
    } catch {
      /* 继续降级 */
    }
  }
  // 3) 网页全屏兜底：国产内核（X5 等）上唯一还能用的形态
  art.fullscreenWeb = !art.fullscreenWeb;
  onFallbackToWeb?.();
}

/** 全屏按钮 html：进入态图标在前、退出态图标在后（初始隐藏），与库内置按钮结构一致 */
export const fullscreenButtonHtml = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:none"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 0-2-2h3M3 16h3a2 2 0 0 0 2 2v3"/></svg>',
].join('');

/** 全屏按钮图标随状态切换：控件重建（resize）后也由调用方补一次同步 */
export function syncFullscreenButtonIcon(on: boolean): void {
  // 不从播放器容器里查：网页全屏时 ArtPlayer 会把播放器节点挪到 <body> 下，
  // 容器内的 querySelector 查不到，只有 document 级查询三种形态都覆盖
  const btn = document.querySelector<HTMLElement>('.art-control-fullscreen');
  if (!btn) return;
  const icons = Array.from(btn.children) as HTMLElement[];
  if (icons[0]) icons[0].style.display = on ? 'none' : '';
  if (icons[1]) icons[1].style.display = on ? '' : 'none';
}

/**
 * 绑定图标状态同步：库的 fullscreen / fullscreenWeb / resize 事件 +
 * iOS video 全屏专用的 webkitbegin/endfullscreen（iPhone 上库收不到 change 事件）。
 * 返回解绑函数供组件 cleanup。
 */
export function bindFullscreenIconSync(
  art: EventfulPlayer & FullscreenPlayerLike
): () => void {
  const sync = () => syncFullscreenButtonIcon(isPlayerFullscreen(art));
  art.on('fullscreen', sync);
  art.on('fullscreenWeb', sync);
  art.on('resize', sync);
  const video = art.video as WebkitVideo | null;
  video?.addEventListener('webkitbeginfullscreen', sync);
  video?.addEventListener('webkitendfullscreen', sync);
  return () => {
    art.off('fullscreen', sync);
    art.off('fullscreenWeb', sync);
    art.off('resize', sync);
    video?.removeEventListener('webkitbeginfullscreen', sync);
    video?.removeEventListener('webkitendfullscreen', sync);
  };
}
