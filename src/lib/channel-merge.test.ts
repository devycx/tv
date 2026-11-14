import { describe, expect, it } from 'vitest';
import {
  bestProbe,
  mergeChannels,
  normalizeChannelName,
  normalizeTvgId,
  type LiveChannelItem,
} from './channel-merge';

const ch = (name: string, url: string, extra: Partial<LiveChannelItem> = {}): LiveChannelItem => ({
  id: url,
  name,
  url,
  ...extra,
});

describe('normalizeChannelName', () => {
  it('CCTV 的各种写法归一成 cctvN', () => {
    expect(normalizeChannelName('CCTV-1 综合')).toBe('cctv1');
    expect(normalizeChannelName('CCTV1高清')).toBe('cctv1');
    expect(normalizeChannelName('央视一套')).toBe('cctv1');
    expect(normalizeChannelName('中央一台')).toBe('cctv1');
    expect(normalizeChannelName('CCTV-5 体育')).toBe('cctv5');
    expect(normalizeChannelName('CCTV-5+ 体育赛事')).toBe('cctv5+');
  });

  it('CCTV-5 与 CCTV-5+ 是不同频道', () => {
    expect(normalizeChannelName('CCTV-5')).not.toBe(normalizeChannelName('CCTV-5+'));
  });

  it('去掉画质后缀与括号备注', () => {
    expect(normalizeChannelName('湖南卫视 HD')).toBe('湖南卫视');
    expect(normalizeChannelName('湖南卫视4K')).toBe('湖南卫视');
    expect(normalizeChannelName('湖南卫视（备用）')).toBe('湖南卫视');
    expect(normalizeChannelName('东方卫视 [线路2]')).toBe('东方卫视');
  });

  it('大小写与分隔符不影响结果', () => {
    expect(normalizeChannelName('cctv-1')).toBe(normalizeChannelName('CCTV 1'));
    expect(normalizeChannelName('')).toBe('');
  });
});

describe('normalizeTvgId', () => {
  it('拉齐大小写与分隔符', () => {
    expect(normalizeTvgId('CCTV-1')).toBe('cctv1');
    expect(normalizeTvgId('cctv1')).toBe('cctv1');
    expect(normalizeTvgId('')).toBe('');
    expect(normalizeTvgId(undefined)).toBe('');
  });
});

describe('mergeChannels', () => {
  it('同名跨源合并为一行，候选顺序保持来源顺序', () => {
    const rows = mergeChannels([
      ch('CCTV-1 综合', 'https://a/1.m3u8', { sourceUrl: 'src-a' }),
      ch('其他', 'https://x/9.m3u8'),
      ch('CCTV1高清', 'https://b/1.m3u8', { sourceUrl: 'src-b' }),
      ch('CCTV-1', 'https://c/1.m3u8', { sourceUrl: 'src-c' }),
    ]);

    expect(rows).toHaveLength(2);
    const cctv1 = rows.find((r) => r.name.includes('CCTV'))!;
    expect(cctv1.candidates.map((c) => c.url)).toEqual([
      'https://a/1.m3u8',
      'https://b/1.m3u8',
      'https://c/1.m3u8',
    ]);
    expect(cctv1.url).toBe('https://a/1.m3u8');
  });

  it('tvg-id 相同但名字不同也合并（央视一套 + CCTV-1）', () => {
    const rows = mergeChannels([
      ch('央视一套', 'https://a/1.m3u8', { tvgId: 'cctv1' }),
      ch('新闻频道', 'https://b/2.m3u8', { tvgId: 'cctv1' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].candidates).toHaveLength(2);
  });

  it('名字只差画质/括号后缀的跨源条目合并', () => {
    const rows = mergeChannels([
      ch('湖南卫视 HD', 'https://a/hn.m3u8'),
      ch('湖南卫视（备用）', 'https://b/hn.m3u8'),
      ch('湖南卫视4K', 'https://c/hn.m3u8'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].candidates).toHaveLength(3);
  });

  it('CCTV-5 与 CCTV-5+ 不合并', () => {
    const rows = mergeChannels([ch('CCTV-5', 'https://a/5.m3u8'), ch('CCTV-5+', 'https://b/5p.m3u8')]);
    expect(rows).toHaveLength(2);
  });

  it('同一 URL 出现在多个订阅里只保留一次', () => {
    const rows = mergeChannels([
      ch('CCTV-1', 'https://same/1.m3u8', { sourceUrl: 'a' }),
      ch('CCTV-1', 'https://same/1.m3u8', { sourceUrl: 'b' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].candidates).toHaveLength(1);
  });

  it('展示名取最干净、最短的候选名', () => {
    const rows = mergeChannels([
      ch('CCTV-1 综合', 'https://a/1.m3u8'),
      ch('CCTV1高清', 'https://b/1.m3u8'),
      ch('央视一套', 'https://c/1.m3u8'),
    ]);
    expect(rows[0].name).toBe('央视一套');
  });

  it('合并后带上频道分组、台标、EPG 与候选数', () => {
    const rows = mergeChannels([
      ch('CCTV-1', 'https://a/1.m3u8', { group: '央视', logo: 'https://a/logo.png', epg: 'https://epg/a.xml' }),
      ch('CCTV1', 'https://b/1.m3u8', { group: '央视' }),
    ]);
    expect(rows[0].group).toBe('央视');
    expect(rows[0].logo).toBe('https://a/logo.png');
    expect(rows[0].epg).toBe('https://epg/a.xml');
    expect(rows[0].candidates).toHaveLength(2);
  });

  it('空输入返回空数组', () => {
    expect(mergeChannels([])).toEqual([]);
  });
});

describe('bestProbe', () => {
  const row = mergeChannels([ch('CCTV-1', 'https://a/1.m3u8'), ch('CCTV1', 'https://b/1.m3u8')])[0];

  it('优先分片级通过', () => {
    const probeOf = (url: string) =>
      url.includes('a/') ? { ok: true, level: 'head' as const } : { ok: true, level: 'segment' as const };
    expect(bestProbe(row, probeOf)?.level).toBe('segment');
  });

  it('没有分片级时退到任何通过', () => {
    const probeOf = (url: string) => (url.includes('b/') ? { ok: true, level: 'manifest' as const } : { ok: false });
    expect(bestProbe(row, probeOf)?.ok).toBe(true);
  });

  it('全都没有结果时返回 undefined', () => {
    expect(bestProbe(row, () => undefined)).toBeUndefined();
  });
});
