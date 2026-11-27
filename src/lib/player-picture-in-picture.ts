/**
 * 小窗播放（画中画）按钮：点播与直播共用。
 *
 * ArtPlayer 的 pipMix 已经覆盖了两条路：标准 requestPictureInPicture（Android Chrome /
 * 桌面）与 iOS 的 webkitSetPresentationMode('picture-in-picture')。
 * 这里只接管按钮：用中文提示代替库内置的英文 "PIP Not Supported"，
 * 并把入口暴露到手机控制条（之前的 CSS 把 pip 按钮在窄屏隐藏了）。
 */

interface PipPlayerLike {
  video: HTMLVideoElement | null;
  pip: boolean;
}

interface EventfulPipPlayer {
  on(name: string, fn: (...args: unknown[]) => unknown): unknown;
  off(name: string, fn: (...args: unknown[]) => unknown): unknown;
}

type WebkitPipVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: boolean;
};

/** 标准 PiP 或 iOS webkit 呈现模式至少有一条可用 */
export function isPipSupported(art?: PipPlayerLike | null): boolean {
  const video = art?.video as WebkitPipVideo | null | undefined;
  const nativeEnabled = Boolean(
    (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled
  );
  return nativeEnabled || Boolean(video?.webkitSupportsPresentationMode);
}

/** 切换小窗播放；不支持时回调给组件展示中文提示 */
export function togglePictureInPicture(
  art: PipPlayerLike,
  onUnsupported?: () => void
): void {
  if (!isPipSupported(art)) {
    onUnsupported?.();
    return;
  }
  try {
    art.pip = !art.pip;
  } catch {
    onUnsupported?.();
  }
}

/** 小窗按钮 html：进入态在前、退出态在后（初始隐藏），与全屏按钮结构一致 */
export const pipButtonHtml = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M12 15h8v-4h-8z" fill="currentColor" stroke="none"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:none"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M14 13h6m-2-2 2 2-2 2"/></svg>',
].join('');

/** 小窗按钮图标随 pip 状态切换（document 级查询：全屏时播放器会被挪走） */
export function syncPipButtonIcon(on: boolean): void {
  const btn = document.querySelector<HTMLElement>('.art-control-pip');
  if (!btn) return;
  const icons = Array.from(btn.children) as HTMLElement[];
  if (icons[0]) icons[0].style.display = on ? 'none' : '';
  if (icons[1]) icons[1].style.display = on ? '' : 'none';
}

/** 绑定 pip 事件同步图标；ArtPlayer 的标准与 webkit 两条路都会 emit('pip', state) */
export function bindPipIconSync(art: EventfulPipPlayer): () => void {
  const sync = (state: unknown) => syncPipButtonIcon(Boolean(state));
  art.on('pip', sync);
  return () => art.off('pip', sync);
}
