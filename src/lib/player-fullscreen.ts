/**
 * 播放器全屏按钮（点播 player-shell 与直播 live-player 共用）。
 *
 * 桌面：ArtPlayer 内置按钮只有容器 Fullscreen API 与 iOS webkitEnterFullscreen
 * 两条路，国产内核（X5）两条都挂时点了没反应 → 这里接管为
 * 「容器原生全屏 → iOS video 原生全屏 → 网页全屏」降级链。
 *
 * 手机：优先走浏览器原生全屏（吞掉地址栏/状态栏，YouTube 同款）+ Screen Orientation
 * 锁横屏（系统旋转锁开启时也能横屏）；iOS 走 video 原生全屏。两者都不可用时才
 * 退化到 CSS 旋转横屏（只能覆盖网页视口，但至少能横屏看片）。
 */

import { prefersTouchPointer } from '@/lib/touch-pointer';

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
  webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void;
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

/** 手机 CSS 旋转横屏的现场：退出时要把节点与样式原样还回去 */
interface RotatedState {
  parent: HTMLElement | null;
  nextSibling: Node | null;
  cssText: string;
  bodyOverflow: string;
  onViewportChange: () => void;
}

/** 每个播放器实例的旋转态（实例卸载时随 cleanup 一并退出） */
const rotatedStates = new WeakMap<object, RotatedState>();

/** 触屏设备（手机 / 平板）：全屏按钮走旋转横屏而不是浏览器原生全屏 */
export function isMobilePlayer(): boolean {
  if (typeof navigator === 'undefined') return false;
  // 以粗指针为准：触屏笔记本 / Windows 触屏桌面的 maxTouchPoints 也 > 0，
  // 但它们是鼠标操作，原生全屏更好，不能被误判成手机
  if (prefersTouchPointer()) return true;
  // 只在窄视口下用触控点数兜底（媒体查询在个别内嵌 WebView 里不可靠）
  return (
    typeof window !== 'undefined' &&
    window.innerWidth < 640 &&
    (navigator.maxTouchPoints ?? 0) > 0
  );
}

/** 播放器此刻是否处于 CSS 旋转横屏 */
export function isRotatedFullscreen(art?: object | null): boolean {
  return Boolean(art && rotatedStates.has(art));
}

/** 视口尺寸 / 方向变化时重算旋转布局：竖屏转 90°，横屏直接铺满 */
const applyRotatedLayout = ($player: HTMLDivElement) => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const portrait = h > w;
  $player.style.width = `${portrait ? h : w}px`;
  $player.style.height = `${portrait ? w : h}px`;
  $player.style.left = portrait ? `${w}px` : '0';
  $player.style.top = '0';
  $player.style.transformOrigin = '0 0';
  $player.style.transform = portrait ? 'rotate(90deg)' : 'none';
};

/** 进入旋转横屏：脱离原容器挂到 body，fixed 铺满视口并按需旋转 */
export function enterRotatedFullscreen(art: FullscreenPlayerLike): void {
  const $player = art.template?.$player;
  if (!$player || rotatedStates.has(art)) return;

  const state: RotatedState = {
    parent: $player.parentElement,
    nextSibling: $player.nextSibling,
    cssText: $player.style.cssText,
    bodyOverflow: document.body.style.overflow,
    onViewportChange: () => applyRotatedLayout($player),
  };
  document.body.appendChild($player);
  $player.style.position = 'fixed';
  $player.style.zIndex = '9999';
  $player.style.margin = '0';
  $player.classList.add('art-rotate-fullscreen');
  applyRotatedLayout($player);
  document.body.style.overflow = 'hidden';
  window.addEventListener('resize', state.onViewportChange);
  window.addEventListener('orientationchange', state.onViewportChange);
  rotatedStates.set(art, state);
  // 控件在 resize 后会重建，让上层补一次图标同步
  (art as unknown as { emit?: (name: string) => void }).emit?.('resize');
  syncFullscreenButtonIcon(true);
}

/** 退出旋转横屏：恢复节点位置、行内样式与页面滚动 */
export function exitRotatedFullscreen(art: FullscreenPlayerLike): void {
  const state = rotatedStates.get(art);
  if (!state) return;
  rotatedStates.delete(art);
  window.removeEventListener('resize', state.onViewportChange);
  window.removeEventListener('orientationchange', state.onViewportChange);
  const $player = art.template?.$player;
  if ($player) {
    $player.classList.remove('art-rotate-fullscreen');
    $player.style.cssText = state.cssText;
    if (state.parent) state.parent.insertBefore($player, state.nextSibling);
    else document.body.appendChild($player);
  }
  document.body.style.overflow = state.bodyOverflow;
  (art as unknown as { emit?: (name: string) => void }).emit?.('resize');
  syncFullscreenButtonIcon(false);
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

/** 播放器此刻是否处于任一形态的全屏（容器 / iOS video / 网页全屏 / CSS 旋转） */
export function isPlayerFullscreen(art?: FullscreenPlayerLike | null): boolean {
  return (
    isContainerFullscreen() ||
    isVideoNativeFullscreen(art?.video) ||
    Boolean(art?.fullscreenWeb) ||
    isRotatedFullscreen(art)
  );
}

/**
 * 原生全屏后锁横屏：Chrome Android 上 Screen Orientation API 只在全屏态生效，
 * 且能盖过系统旋转锁；iOS 没有该 API，video 原生全屏自己会横过来。
 * 失败不致命——全屏本身已经生效，只是方向跟随系统。
 */
const lockLandscape = async () => {
  try {
    const orientation = screen.orientation as
      | (ScreenOrientation & { lock?: (value: string) => Promise<void> })
      | undefined;
    if (!orientation?.lock) return;
    try {
      await orientation.lock('landscape');
    } catch {
      try {
        await orientation.lock('landscape-primary');
      } catch {
        /* 浏览器不允许锁方向时忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
};

/** 退出全屏时解除方向锁，让页面恢复跟随系统 */
const unlockOrientation = () => {
  try {
    void screen.orientation?.unlock?.();
  } catch {
    /* 忽略 */
  }
};

/**
 * 全屏切换降级链。
 *
 * @param onFallbackToWeb 桌面容器与 iOS video 全屏都不可用、被迫降级到网页全屏时回调
 * @param onRotatedEnter 手机连原生全屏都没有、退化到 CSS 旋转横屏时回调
 */
export async function togglePlayerFullscreen(
  art: FullscreenPlayerLike,
  onFallbackToWeb?: () => void,
  onRotatedEnter?: () => void
): Promise<void> {
  const video = art.video as WebkitVideo | null;
  const $player = art.template?.$player as WebkitPlayerElement | null | undefined;

  // —— 手机：原生全屏（YouTube 同款，覆盖地址栏/状态栏）优先，锁横屏 ——
  if (isMobilePlayer()) {
    // 退出：CSS 旋转态 / iOS video 原生全屏 / 容器原生全屏，各走各的退出路径
    if (isRotatedFullscreen(art)) {
      exitRotatedFullscreen(art);
      return;
    }
    if (isVideoNativeFullscreen(video)) {
      try { video?.webkitExitFullscreen?.(); } catch { /* 忽略 */ }
      return;
    }
    if (isContainerFullscreen()) {
      try {
        const doc = document as WebkitDocument;
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else await doc.webkitExitFullscreen?.();
      } catch { /* 忽略 */ }
      unlockOrientation();
      return;
    }
    if (art.fullscreenWeb) {
      art.fullscreenWeb = false;
      return;
    }

    // 进入 1) 容器原生全屏：Chrome/Android 上会隐藏地址栏与状态栏；
    //       navigationUI:hide 让支持该选项的浏览器连导航条一起收起。
    const requestFullscreenFn =
      $player?.requestFullscreen ?? $player?.webkitRequestFullscreen;
    if (requestFullscreenFn) {
      try {
        await requestFullscreenFn.call($player, { navigationUI: 'hide' });
        void lockLandscape();
        return;
      } catch { /* 继续降级 */ }
    }
    // 进入 2) video 元素的原生全屏：iOS Safari / WKWebView 上这才是真全屏
    if (video && typeof video.requestFullscreen === 'function') {
      try {
        await video.requestFullscreen({ navigationUI: 'hide' });
        void lockLandscape();
        return;
      } catch { /* 继续降级 */ }
    }
    if (typeof video?.webkitEnterFullscreen === 'function') {
      try {
        video.webkitEnterFullscreen();
        return;
      } catch { /* 继续降级 */ }
    }
    // 进入 3) 最后的兜底：CSS 旋转横屏（无法隐藏浏览器 UI，但至少能横着看）
    enterRotatedFullscreen(art);
    onRotatedEnter?.();
    return;
  }

  // —— 桌面：容器原生全屏 → iOS video 全屏 → 网页全屏 ——
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
    // 组件卸载时若仍在旋转横屏，把播放器节点与样式还回原处再交给 art.destroy
    exitRotatedFullscreen(art);
  };
}
