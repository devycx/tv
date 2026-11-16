import { buildImageCandidates } from './utils';

/**
 * 媒体会话（锁屏 / 通知栏 / 系统媒体控件）的**纯逻辑**：元数据构造、封面候选、进度夹取。
 *
 * 这里刻意不碰任何浏览器 API：注册 handler、写 navigator.mediaSession 都在
 * components/use-media-session.ts，便于单测（vitest 是 node 环境，没有 DOM）。
 *
 * 字段按 2026-11-16 用户决定：通知栏只出「片名 + 集数」，**不显示来源和总集数**。
 */

export interface MediaArtwork {
  src: string;
  /** 声明尺寸会参与浏览器选图：太小可能被忽略，太大则会放大糊 */
  sizes?: string;
  type?: string;
}

export interface MediaInfo {
  title: string;
  /** 通知栏/锁屏的副标题行：点播是多集的「第 3 集」，直播是分组或「直播」 */
  artist?: string;
  album?: string;
  artwork?: MediaArtwork[];
}

/** 无封面时的兜底：站点图标，同源、512、一定有 */
export const FALLBACK_ARTWORK = '/icons/icon-512.png';

const IMAGE_TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.png(?:$|[?#])/i, 'image/png'],
  [/\.webp(?:$|[?#])/i, 'image/webp'],
  [/\.gif(?:$|[?#])/i, 'image/gif'],
  [/\.avif(?:$|[?#])/i, 'image/avif'],
  [/\.jpe?g(?:$|[?#])/i, 'image/jpeg'],
];

export function artworkType(src: string): string | undefined {
  for (const [pattern, type] of IMAGE_TYPES) {
    if (pattern.test(src)) return type;
  }
  return undefined;
}

const DOUBAN_HOSTS: readonly RegExp[] = [
  /(?:^|\.)doubanio\.com$/i,
  /(?:^|\.)doubanio\.viki\.moe$/i,
  // utils.buildImageCandidates 里的公共镜像（豆瓣原站对空 Referer 回 403/418）
  /^img\.doubanio\.cmliussss\.(?:net|com)$/i,
];

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isDoubanImage(url: string): boolean {
  const host = hostnameOf(url);
  return Boolean(host) && DOUBAN_HOSTS.some((pattern) => pattern.test(host));
}

/**
 * 豆瓣海报尺寸升级：`s_ratio_poster` 只有 270×400，`m` 是 540×800（2026-11-16 实测）。
 * 通知栏封面在 Android 上按 512 量级渲染，270 宽会明显发虚；只动豆瓣域名下的海报路径，
 * 其它源站的封面原样返回（它们的尺寸我们无从得知）。
 */
export function upgradeDoubanArtwork(url: string): string {
  if (!url.includes('/s_ratio_poster/')) return url;
  if (!isDoubanImage(url)) return url;
  return url.replace('/s_ratio_poster/', '/m/');
}

function sizesFor(src: string): string {
  // 只有升级过的豆瓣 /m/ 尺寸是确定的（540×800）；其它一律按方形 512 声明
  return /\/photo\/m\//.test(src) ? '540x800' : '512x512';
}

export function artworkEntry(src: string): MediaArtwork {
  return { src, sizes: sizesFor(src), type: artworkType(src) };
}

/**
 * 封面 → artwork。
 * 候选链与卡片/详情页共用（buildImageCandidates）：豆瓣图先走公共镜像，且镜像带
 * `Access-Control-Allow-Origin: *`、不带 Referer 也能取到（原站空 Referer 会 418），
 * 锁屏封面正是浏览器自己去取图的场景。
 */
export function resolveArtwork(
  cover: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customProxy = ''
): MediaArtwork {
  const candidate = buildImageCandidates(cover, mode, customProxy)[0];
  if (!candidate) {
    return { src: FALLBACK_ARTWORK, sizes: '512x512', type: 'image/png' };
  }
  return artworkEntry(upgradeDoubanArtwork(candidate));
}

export function buildMediaInfo(input: {
  title: string;
  /** artist 行：多集时为「第 3 集」，直播为分组/「直播」 */
  subtitle?: string;
  artwork?: MediaArtwork;
}): MediaInfo {
  const info: MediaInfo = { title: input.title.trim() || '夜幕影视' };
  const subtitle = input.subtitle?.trim();
  if (subtitle) info.artist = subtitle;
  if (input.artwork) info.artwork = [input.artwork];
  return info;
}

export interface PositionState {
  duration: number;
  position: number;
  playbackRate: number;
}

/**
 * `setPositionState` 对入参很挑：duration 必须是有限正数、position 要落在 [0, duration]、
 * playbackRate 要在 [0.0625, 16]。直播流（duration = Infinity）和元数据未就绪时一律返回 null，
 * 由调用方跳过——直接传非法值在 Safari 上会抛异常。
 */
export function buildPositionState(
  position: number,
  duration: number,
  playbackRate = 1
): PositionState | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(position)) return null;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return {
    duration,
    position: Math.min(Math.max(position, 0), duration),
    playbackRate: Math.min(Math.max(rate, 0.0625), 16),
  };
}

/** Media Session 能力检测：Safari 15 早期版本只有 mediaSession 没有 MediaMetadata */
export function supportsMediaSession(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof MediaMetadata !== 'undefined' &&
    'mediaSession' in navigator
  );
}
