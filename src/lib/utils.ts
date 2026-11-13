export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 停用时长的可读文案：不足 1 小时按分钟，超过按小时（按剩余时间展示时向上取整） */
export function formatDisableTtl(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 60 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`;
}

/**
 * 封面图加载地址：direct 原站直连 / custom 自定义模板（{url} 占位符或直接拼接）。
 *
 * 旧版内置图片代理（/api/proxy）已删除：Cloudflare 只提供页面/静态资源/JSON API，
 * 封面也由浏览器直连（豆瓣走公共镜像，见 buildImageCandidates）。
 * 「proxy」参数仅为兼容旧设置/旧配置导入保留，行为等同 direct。
 */
export function buildImageUrl(
  url: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customTemplate: string
): string | undefined {
  if (!url) return undefined;
  // 「proxy」是旧版内置图片代理模式，现已移除：一律按直连处理，不再经过本站 Worker。
  if (mode === 'custom' && customTemplate) {
    return customTemplate.includes('{url}')
      ? customTemplate.replace('{url}', encodeURIComponent(url))
      : customTemplate + encodeURIComponent(url);
  }
  return url;
}

/**
 * 封面图降级候选链（全部为浏览器直连，不经本站 Worker）：
 * - 非 custom 模式：豆瓣图优先走 cmliussss 公共镜像（net / com），再回退原站；
 *   非豆瓣图只有原站一个候选。
 *   doubanio 原站对外域/空 Referer 会返回 403/418，纯前端无法绕过，所以镜像排在最前。
 * - custom 模式为单一地址：模板错误应显式暴露，不被静默回退掩盖。
 *
 * 旧版「内置 /api/proxy 图片代理」已删除：Cloudflare 只提供页面/静态资源/JSON API，
 * 封面也由客户端直连（`<img referrerPolicy="no-referrer">`）。
 */
export function buildImageCandidates(
  url: string | undefined,
  mode: 'direct' | 'proxy' | 'custom',
  customTemplate: string
): string[] {
  if (!url) return [];
  if (mode === 'custom') {
    const built = buildImageUrl(url, mode, customTemplate);
    return built ? [built] : [];
  }
  const isDoubanHost = /(?:^|\.)doubanio\.com$/i.test(safeHostname(url)) || /(?:^|\.)doubanio\.viki\.moe$/i.test(safeHostname(url));
  const mirrors = isDoubanHost
    ? [
        url.replace(
          /^(https?:\/\/)(?:img\d+\.doubanio\.com|doubanio\.viki\.moe)(?=\/)/i,
          '$1img.doubanio.cmliussss.net'
        ),
        url.replace(
          /^(https?:\/\/)(?:img\d+\.doubanio\.com|doubanio\.viki\.moe)(?=\/)/i,
          '$1img.doubanio.cmliussss.com'
        ),
      ]
    : [];
  return [...new Set([...mirrors, url])];
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function validateSourceUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url);
}

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 为分享链接等场景构造观看页 URL */
export function buildWatchUrl(params: {
  sourceKey: string;
  vodId?: string;
  index?: number;
  title?: string;
  episodeUrl?: string;
  sourceUrl?: string;
  detail?: string;
}): string {
  const sp = new URLSearchParams();
  sp.set('source', params.sourceKey);
  if (params.vodId) sp.set('id', params.vodId);
  if (typeof params.index === 'number') sp.set('index', String(params.index));
  if (params.title) sp.set('title', params.title);
  if (params.episodeUrl) sp.set('url', params.episodeUrl);
  if (params.sourceUrl) sp.set('sourceUrl', params.sourceUrl);
  if (params.detail) sp.set('detail', params.detail);
  return `/watch?${sp.toString()}`;
}
