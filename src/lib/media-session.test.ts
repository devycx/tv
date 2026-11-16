import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_ARTWORK,
  artworkEntry,
  artworkType,
  buildMediaInfo,
  buildPositionState,
  isDoubanImage,
  resolveArtwork,
  supportsMediaSession,
  upgradeDoubanArtwork,
} from './media-session';

/**
 * 驱动真正的构造逻辑，替身只用在浏览器 API 探测上。
 * 盯的是三类会静默坏掉的事：
 * 1) 通知栏字段跑回「来源 / 总集数」（用户明确不要）；
 * 2) 封面拿成豆瓣原站（空 Referer 418）或 270×400 的 s_ratio_poster；
 * 3) 直播/未就绪时把非法 duration 塞进 setPositionState（Safari 会抛）。
 */

const DOUBAN_COVER = 'https://img9.doubanio.com/view/photo/s_ratio_poster/public/p480747492.jpg';
const MIRROR_COVER = 'https://img.doubanio.cmliussss.net/view/photo/s_ratio_poster/public/p480747492.jpg';
const SOURCE_COVER = 'https://cdn.example.com/upload/vod/20240101/poster.jpg';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildMediaInfo', () => {
  it('只有片名时只出 title（不补来源、不补总集数）', () => {
    const info = buildMediaInfo({ title: '庆余年' });
    expect(info).toEqual({ title: '庆余年' });
  });

  it('多集时集数落在 artist 行，album 留空', () => {
    const info = buildMediaInfo({ title: '庆余年', subtitle: '第 3 集' });
    expect(info).toEqual({ title: '庆余年', artist: '第 3 集' });
    expect(info.album).toBeUndefined();
  });

  it('标题为空时退回站名，副标题空白视为没有', () => {
    expect(buildMediaInfo({ title: '   ' }).title).toBe('夜幕影视');
    expect(buildMediaInfo({ title: '片名', subtitle: '   ' }).artist).toBeUndefined();
  });

  it('封面只放一项：多放一项 512 站标会让浏览器挑错图', () => {
    const artwork = artworkEntry('https://cdn.example.com/a.jpg');
    expect(buildMediaInfo({ title: '片名', artwork }).artwork).toHaveLength(1);
    expect(buildMediaInfo({ title: '片名', artwork }).artwork?.[0].src).toBe(
      'https://cdn.example.com/a.jpg'
    );
  });
});

describe('artworkType', () => {
  it('按后缀给出 MIME，query 不影响判断', () => {
    expect(artworkType('https://a.com/x.jpg')).toBe('image/jpeg');
    expect(artworkType('https://a.com/x.JPEG?x=1')).toBe('image/jpeg');
    expect(artworkType('https://a.com/x.png')).toBe('image/png');
    expect(artworkType('https://a.com/x.webp')).toBe('image/webp');
    expect(artworkType('https://a.com/x')).toBeUndefined();
  });
});

describe('isDoubanImage / upgradeDoubanArtwork', () => {
  it('认豆瓣原站、热榜镜像与 cmliussss 公共镜像', () => {
    expect(isDoubanImage(DOUBAN_COVER)).toBe(true);
    expect(isDoubanImage(MIRROR_COVER)).toBe(true);
    expect(isDoubanImage('https://doubanio.viki.moe/view/photo/m/public/p1.jpg')).toBe(true);
    expect(isDoubanImage(SOURCE_COVER)).toBe(false);
    expect(isDoubanImage('not a url')).toBe(false);
  });

  it('s_ratio_poster → m（270×400 → 540×800）', () => {
    expect(upgradeDoubanArtwork(MIRROR_COVER)).toBe(
      'https://img.doubanio.cmliussss.net/view/photo/m/public/p480747492.jpg'
    );
    expect(upgradeDoubanArtwork(DOUBAN_COVER)).toContain('/view/photo/m/');
  });

  it('非豆瓣域名与非海报路径原样返回', () => {
    expect(upgradeDoubanArtwork(SOURCE_COVER)).toBe(SOURCE_COVER);
    expect(upgradeDoubanArtwork('https://img9.doubanio.com/view/photo/l/public/p1.jpg')).toBe(
      'https://img9.doubanio.com/view/photo/l/public/p1.jpg'
    );
  });
});

describe('resolveArtwork', () => {
  it('豆瓣图走公共镜像 + /m/，尺寸声明成 540×800', () => {
    const artwork = resolveArtwork(DOUBAN_COVER, 'direct');
    expect(artwork).toEqual({
      src: 'https://img.doubanio.cmliussss.net/view/photo/m/public/p480747492.jpg',
      sizes: '540x800',
      type: 'image/jpeg',
    });
  });

  it('自定义图片代理模板优先（与卡片同一条链）', () => {
    const artwork = resolveArtwork(DOUBAN_COVER, 'custom', 'https://proxy.example.com/?u=');
    expect(artwork.src).toBe(`https://proxy.example.com/?u=${encodeURIComponent(DOUBAN_COVER)}`);
    // 升级只对豆瓣域名生效，代理后的地址不能动
    expect(artwork.src).not.toContain('/photo/m/');
  });

  it('普通源站封面原样使用，按 512 方形声明', () => {
    expect(resolveArtwork(SOURCE_COVER, 'direct')).toEqual({
      src: SOURCE_COVER,
      sizes: '512x512',
      type: 'image/jpeg',
    });
  });

  it('没有封面时退回站标（直链播放、源站没图）', () => {
    expect(resolveArtwork(undefined, 'direct')).toEqual({
      src: FALLBACK_ARTWORK,
      sizes: '512x512',
      type: 'image/png',
    });
    expect(resolveArtwork('', 'direct').src).toBe(FALLBACK_ARTWORK);
  });
});

describe('buildPositionState', () => {
  it('正常值原样透出', () => {
    expect(buildPositionState(30, 2700, 1)).toEqual({
      duration: 2700,
      position: 30,
      playbackRate: 1,
    });
  });

  it('position 夹在 [0, duration]', () => {
    expect(buildPositionState(-5, 100)?.position).toBe(0);
    expect(buildPositionState(120, 100)?.position).toBe(100);
  });

  it('时长缺失/直播（Infinity）一律跳过：这条路径会把 Safari 抛崩', () => {
    expect(buildPositionState(10, 0)).toBeNull();
    expect(buildPositionState(10, Number.POSITIVE_INFINITY)).toBeNull();
    expect(buildPositionState(10, Number.NaN)).toBeNull();
    expect(buildPositionState(Number.NaN, 100)).toBeNull();
  });

  it('倍速非法时退回 1，越界时夹到允许区间', () => {
    expect(buildPositionState(1, 100, 0)?.playbackRate).toBe(1);
    expect(buildPositionState(1, 100, Number.NaN)?.playbackRate).toBe(1);
    expect(buildPositionState(1, 100, 3)?.playbackRate).toBe(3);
    expect(buildPositionState(1, 100, 100)?.playbackRate).toBe(16);
  });
});

describe('supportsMediaSession', () => {
  it('node 环境（无 navigator）返回 false，不抛异常', () => {
    expect(supportsMediaSession()).toBe(false);
  });

  it('有 mediaSession + MediaMetadata 才算支持', () => {
    vi.stubGlobal('navigator', { mediaSession: {} });
    expect(supportsMediaSession()).toBe(false);
    vi.stubGlobal('MediaMetadata', class {});
    expect(supportsMediaSession()).toBe(true);
  });
});
