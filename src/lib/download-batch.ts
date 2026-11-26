import type { AddDownloadPayload } from '@/components/download-manager';

/**
 * 把一部影视的分集列表转成批量下载任务。
 *
 * 分集地址来自 CMS 的 vod_play_url（只保留 URL，集名在解析时丢弃），
 * 所以标题统一按「片名 第N集」生成；单集视频不加集数后缀。
 */
export function buildEpisodeDownloadPayloads(
  title: string,
  episodes: string[],
  format: AddDownloadPayload['format'] = 'MP4'
): AddDownloadPayload[] {
  const name = title.trim() || '未命名';
  const urls = episodes.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
  const multi = urls.length > 1;
  return urls
    .map((url, i) => ({
      url,
      title: multi ? `${name} 第${i + 1}集` : name,
      format,
    }));
}
