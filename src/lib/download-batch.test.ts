import { describe, expect, it } from 'vitest';
import { buildEpisodeDownloadPayloads } from './download-batch';

describe('buildEpisodeDownloadPayloads', () => {
  it('多集按第N集命名，顺序与分集地址一致', () => {
    const episodes = ['https://cdn.example/1.m3u8', 'https://cdn.example/2.m3u8'];
    expect(buildEpisodeDownloadPayloads('庆余年', episodes)).toEqual([
      { url: episodes[0], title: '庆余年 第1集', format: 'MP4' },
      { url: episodes[1], title: '庆余年 第2集', format: 'MP4' },
    ]);
  });

  it('单集电影不加集数后缀', () => {
    expect(buildEpisodeDownloadPayloads('流浪地球', ['https://cdn.example/movie.m3u8'], 'TS')).toEqual([
      { url: 'https://cdn.example/movie.m3u8', title: '流浪地球', format: 'TS' },
    ]);
  });

  it('空标题与非 http 地址被过滤', () => {
    expect(buildEpisodeDownloadPayloads('  ', ['', 'ftp://x/y', 'https://cdn.example/1.m3u8'])).toEqual([
      { url: 'https://cdn.example/1.m3u8', title: '未命名', format: 'MP4' },
    ]);
  });
});
