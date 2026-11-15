/**
 * 封面指纹（纯函数，便于单测）。
 *
 * 搜索结果按封面聚合的前提是：不同源站上的同一张封面要能得到同一个 key。
 * 采集站互相抄数据，封面通常就是一个文件被复制到各家图床：
 *
 * - 文件名是内容哈希（`78288c7898fdad99aee06e3b42213c7b.jpg`）：同一张图在不同
 *   域名/目录下文件名不变，按「哈希文件名」归一即可跨站合并；
 * - 其他文件名（`1828115.webp`、`1.jpg`）：不同站点的同名文件很可能是不同影片，
 *   只做「同 host + 同路径」的归一（去协议、去查询串、去缩略图后缀），不跨站合并。
 *
 * 只把「≥16 位十六进制」当成内容哈希。数字 id（如 `1828115`）在不同采集站可能
 * 指向不同影片，不能当内容指纹；宁可少合并，也不要把两部不同的片子并成一张卡。
 */

const IMAGE_EXT = '(?:jpe?g|png|webp|gif|avif|bmp|jxl)';
const EXT_TAIL = new RegExp(`\\.${IMAGE_EXT}$`, 'i');
/** 图床缩略图后缀：`poster_300x400.jpg` / `poster-300x400.jpg` / `poster@300w.jpg` */
const THUMB_SUFFIX = new RegExp(`(?:[_-]\\d{2,4}x\\d{2,4}|@\\d+w)(?=\\.${IMAGE_EXT}$)`, 'i');
/** 内容哈希：纯十六进制、至少 16 位（含 UUID 去掉分隔符后的形态） */
const CONTENT_HASH = /^[0-9a-f]{16,}$/;

export function coverFingerprint(raw?: string): string | undefined {
  const text = raw?.trim();
  if (!text || /^data:/i.test(text)) return undefined;

  let url: URL;
  try {
    // 相对地址（`/upload/x.jpg`）没有 host：用保留域名解析，最后单独走 path 分支
    url = new URL(text, 'https://relative.invalid/');
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  path = path.toLowerCase().replace(THUMB_SUFFIX, '');

  const file = path.split('/').pop() ?? '';
  const stem = file.replace(EXT_TAIL, '');
  if (!stem) return undefined;

  const compact = stem.replace(/[-_]/g, '');
  if (CONTENT_HASH.test(compact)) return `hash:${compact}`;

  // 相对地址没有可比对的 host：只能按路径归一，保持与旧行为一致的保守合并
  if (url.hostname === 'relative.invalid') return `path:${path}`;

  // www 前缀不影响图床身份；保留 host 是为了避免不同站点的同名文件被误合并
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return `url:${host}${path}`;
}
