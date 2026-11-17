import { describe, expect, it } from 'vitest';
import { buildImageCandidates, buildImageUrl, buildWatchUrl } from './utils';

describe('buildImageUrl', () => {
  it('旧 proxy 模式已移除：一律返回原站直连地址', () => {
    expect(buildImageUrl('https://img3.doubanio.com/a.jpg', 'proxy', '')).toBe(
      'https://img3.doubanio.com/a.jpg'
    );
  });

  it('direct 与 custom 模式', () => {
    expect(buildImageUrl('https://x.com/a.jpg', 'direct', '')).toBe('https://x.com/a.jpg');
    expect(buildImageUrl('https://x.com/a.jpg', 'custom', 'https://p.example.com/?u=')).toBe(
      'https://p.example.com/?u=' + encodeURIComponent('https://x.com/a.jpg')
    );
    expect(buildImageUrl(undefined, 'proxy', '')).toBeUndefined();
  });
});

describe('buildImageCandidates', () => {
  const DOUBAN = 'https://img3.doubanio.com/view/photo/m/poster.jpg';

  it('豆瓣图：双公共镜像优先 → 原站直连，不含 /api/proxy', () => {
    expect(buildImageCandidates(DOUBAN, 'direct', '')).toEqual([
      'https://img.doubanio.cmliussss.net/view/photo/m/poster.jpg',
      'https://img.doubanio.cmliussss.com/view/photo/m/poster.jpg',
      DOUBAN,
    ]);
    expect(buildImageCandidates(DOUBAN, 'direct', '').some((u) => u.includes('/api/proxy'))).toBe(false);
  });

  it('热榜镜像 doubanio.viki.moe 也映射到 cmliussss', () => {
    expect(
      buildImageCandidates('https://doubanio.viki.moe/view/photo/s_ratio_poster/public/p1.jpg', 'direct', '')
    ).toEqual([
      'https://img.doubanio.cmliussss.net/view/photo/s_ratio_poster/public/p1.jpg',
      'https://img.doubanio.cmliussss.com/view/photo/s_ratio_poster/public/p1.jpg',
      'https://doubanio.viki.moe/view/photo/s_ratio_poster/public/p1.jpg',
    ]);
  });

  it('非豆瓣图：只有原站直连', () => {
    expect(buildImageCandidates('https://bdstatic.com/x.jpg', 'direct', '')).toEqual([
      'https://bdstatic.com/x.jpg',
    ]);
  });

  it('旧 proxy 模式与 direct 行为一致', () => {
    expect(buildImageCandidates(DOUBAN, 'proxy', '')).toEqual(
      buildImageCandidates(DOUBAN, 'direct', '')
    );
  });

  it('custom 模式为单一候选（模板错误显式暴露，不静默回退）', () => {
    expect(buildImageCandidates(DOUBAN, 'custom', 'https://p.example.com/?u=')).toHaveLength(1);
    expect(buildImageCandidates(undefined, 'direct', '')).toEqual([]);
  });
});

describe('buildWatchUrl', () => {
  it('切源续播：大于 3 秒才写入 position（取整）', () => {
    const url = buildWatchUrl({ sourceKey: 's1', vodId: 'v1', index: 2, position: 125.7 });
    const sp = new URLSearchParams(url.split('?')[1]);
    expect(sp.get('position')).toBe('125');
    expect(sp.get('index')).toBe('2');
  });

  it('片头几秒的进度不写入分享链接', () => {
    const url = buildWatchUrl({ sourceKey: 's1', vodId: 'v1', position: 2 });
    expect(url).not.toContain('position=');
    const nan = buildWatchUrl({ sourceKey: 's1', vodId: 'v1', position: Number.NaN });
    expect(nan).not.toContain('position=');
  });
});
