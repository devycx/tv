import type { SearchResultItem, VideoDetail } from './types';
import { isCloseMatch } from './text-similarity';
import { stripHtmlToText } from './html-text';

/**
 * Apple CMS（苹果CMS）资源站响应解析
 * 与旧版 js/api.js 逻辑对齐，迁移为纯函数以便单元测试。
 */

const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;

/** 简介里内嵌的播放直链：分集兜底提取用得到，但不该出现在「简介」里给用户看 */
const PLAY_LINK_IN_DESC = /\$?\s*https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/gi;

const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export function cmsRequestHeaders(): Record<string, string> {
  return { ...UA_HEADERS };
}

/** 搜索响应 → 统一结果列表 */
export function parseSearchList(
  data: unknown,
  source: { key: string; name: string; url: string; isAdult?: boolean }
): SearchResultItem[] {
  if (!data || typeof data !== 'object') throw new Error('API返回的数据格式无效');
  const list = (data as { list?: unknown }).list;
  // 部分源站无结果时返回 list: null（而非 []），视为空结果而非格式错误
  if (list !== null && list !== undefined && !Array.isArray(list)) {
    throw new Error('API返回的数据格式无效');
  }
  return (Array.isArray(list) ? list : []).map((item) => {
    const vod = item as Record<string, unknown>;
    const typeName = typeof vod.type_name === 'string' ? vod.type_name : undefined;
    return {
      sourceKey: source.key,
      sourceName: source.name,
      vodId: String(vod.vod_id ?? ''),
      name: String(vod.vod_name ?? ''),
      pic: typeof vod.vod_pic === 'string' ? vod.vod_pic : undefined,
      typeName,
      year: typeof vod.vod_year === 'string' ? vod.vod_year : undefined,
      area: typeof vod.vod_area === 'string' ? vod.vod_area : undefined,
      remarks: typeof vod.vod_remarks === 'string' ? vod.vod_remarks : undefined,
      sourceUrl: source.url,
      // 源级 18+ 标记之外，再按分类名 / 片名强特征识别成人内容：
      // 这样即使源没标 isAdult，搜索结果也能打 18🈲 徽章，并参与「成人内容过滤」。
      isAdult: Boolean(source.isAdult) || isAdultType(typeName) || isAdultTitle(String(vod.vod_name ?? '')),
    };
  });
}

/**
 * 从 vod_play_url 中提取分集地址：格式 源1$$$源2，集1$URL1#集2$URL2。
 * 部分源（如量子 lziapi、非凡 ffzy）第一条线路是网页中转页（…/share/xxx，不可播），
 * 真实 m3u8 在后面的线路里，因此优先取包含 m3u8 直链的线路；均无 m3u8 时回退第一条。
 */
export function extractEpisodesFromPlayUrl(playUrl: string): string[] {
  if (!playUrl) return [];
  const groups = playUrl
    .split('$$$')
    .map((group) =>
      group
        .split('#')
        .map((ep) => {
          const parts = ep.split('$');
          return parts.length > 1 ? parts[1] : '';
        })
        .filter((url) => url.startsWith('http://') || url.startsWith('https://'))
    )
    .filter((eps) => eps.length > 0);
  if (groups.length === 0) return [];
  return groups.find((eps) => eps.some((url) => url.includes('.m3u8'))) ?? groups[0];
}

/** 从简介文本中兜底提取 m3u8 链接 */
export function extractM3u8FromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(M3U8_PATTERN) || [];
  return matches.map((link) => link.replace(/^\$/, ''));
}

/** 详情 JSON 响应 → 统一详情 */
export function parseDetail(
  data: unknown,
  source: { key: string; name: string; url: string }
): VideoDetail {
  const d = data as { list?: Record<string, unknown>[] };
  if (!d || !Array.isArray(d.list) || d.list.length === 0) {
    throw new Error('获取到的详情内容无效');
  }
  const vod = d.list[0];
  let episodes = extractEpisodesFromPlayUrl(String(vod.vod_play_url ?? ''));
  if (episodes.length === 0) {
    // 注意：兜底提取链接必须用原始 HTML（这里不能先清洗），否则 m3u8 会被一起洗掉
    episodes = extractM3u8FromText(String(vod.vod_content ?? ''));
  }
  return {
    episodes,
    videoInfo: {
      title: str(vod.vod_name),
      cover: str(vod.vod_pic),
      // vod_content 是富文本（公众号排版导出常见），洗成纯文本再给 UI：
      // 直接把 HTML 当文本渲染会露出 <span style="...">，见 lib/html-text.ts。
      // 顺手摘掉内嵌的播放直链（只影响展示，分集仍用原始 HTML 提取）
      desc:
        stripHtmlToText(str(vod.vod_content))
          .replace(PLAY_LINK_IN_DESC, ' ')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim() || undefined,
      typeName: str(vod.type_name),
      year: str(vod.vod_year),
      area: str(vod.vod_area),
      director: str(vod.vod_director),
      actor: str(vod.vod_actor),
      remarks: str(vod.vod_remarks),
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/**
 * 部分源的列表接口不返回播放地址，需要爬详情页 HTML 提取 m3u8。
 * 与旧版 handleSpecialSourceDetail 对齐。
 */
export function parseDetailPageHtml(
  html: string,
  source: { key: string; name: string; url: string }
): VideoDetail {
  // 先尝试通用模式，再尝试非凡影视的日期哈希特征路径
  let matches = html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
  if (matches.length === 0) {
    matches = html.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
  }
  // 去重并清理尾缀
  const episodes = [...new Set(matches)].map((link) => {
    let u = link.substring(1);
    const parenIndex = u.indexOf('(');
    if (parenIndex > 0) u = u.substring(0, parenIndex);
    return u;
  });

  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);

  return {
    episodes,
    videoInfo: {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      desc: stripHtmlToText(descMatch ? descMatch[1] : undefined) || undefined,
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

/**
 * 敏感分类过滤（成人内容过滤）。
 *
 * 拆成「分类名规则」与「片名强特征规则」两套词表（2026-11-20）：
 * 分类名可以宽（源站分类就叫「伦理片」「福利」「擦边」），但片名不能共用同一套——
 * `'AV'` 之类的短词做子串匹配时会误杀 Avatar / Avengers / Gravity / Maverick 等
 * 正常英文片名，`'成人'`「福利」「伦理」「三级」「自拍」「换脸」「cosplay」
 * 也会吃掉《成人礼》这类中文片名。
 */
const ADULT_TYPE_KEYWORDS = [
  '伦理片', '倫理片', '福利片', '福利视频', '日本伦理', '日本福利', '日本伦理片', '日本福利片',
  '韩国伦理', '擦边短剧', '擦边', '里番动漫', '里番', '门事件',
  '萝莉少女', '制服诱惑', '国产传媒', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码',
  '网红主播', '色情片', '同性片', '91视频', '自拍偷拍', 'mini传媒',
  // 用户反馈补充：成人 / 情色 / 三级 / 女优 / 换脸等分类也要能打 18🈲 并参与过滤
  '成人', '色情', '情色', '三级', '18禁', '女优', '换脸', '日本片商',
  '伦理', '福利', '自拍', '偷拍', 'cosplay',
];

/** 片名匹配：只保留极低误杀率的强特征词（不通用于分类名的宽词） */
const ADULT_TITLE_KEYWORDS = [
  '无码', '有码', '色情', '情色', '18禁', '里番', '女优', '日本片商',
  '自拍偷拍', '黑丝诱惑', '制服诱惑', '国产传媒', 'mini传媒', '91视频',
];

/**
 * 英文 / 字母缩写必须做词边界匹配：否则 `av` 会命中 Avatar、Avengers、Gravity。
 * 前后都不允许再跟字母数字，`AV` 本身/`AV-1`/`AV 女优` 仍然能命中。
 */
const ADULT_TOKEN_REGEX = /(?<![a-z0-9])(av|r18|swag|h漫)(?![a-z0-9])/i;

function includesAdultKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/** 分类名（type_name / 直播分组）判定：词表较宽，英文短词走边界正则 */
export function isAdultType(typeName: string | undefined): boolean {
  if (!typeName) return false;
  if (ADULT_TOKEN_REGEX.test(typeName)) return true;
  return includesAdultKeyword(typeName, ADULT_TYPE_KEYWORDS);
}

/** 片名判定：只认强特征词 + 英文短词边界，避免误杀正常影视 */
export function isAdultTitle(title: string | undefined): boolean {
  if (!title) return false;
  if (ADULT_TOKEN_REGEX.test(title)) return true;
  return includesAdultKeyword(title, ADULT_TITLE_KEYWORDS);
}

/** 统一判定入口：源标记 / 分类名 / 片名任一命中即视为成人内容 */
export function isAdultItem(item: {
  isAdult?: boolean;
  typeName?: string;
  name?: string;
}): boolean {
  return Boolean(item.isAdult) || isAdultType(item.typeName) || isAdultTitle(item.name);
}

/** 兼容旧导出名：只按分类名口径判断（历史调用方与单测用它检查分类词表） */
export function isAdultContent(text: string | undefined): boolean {
  return isAdultType(text);
}

export function filterAdultResults<
  T extends { typeName?: string; name?: string; isAdult?: boolean },
>(items: T[], enabled: boolean): T[] {
  if (!enabled) return items;
  return items.filter((item) => !isAdultItem(item));
}

/**
 * 归一化标题/关键词：去空白、标点与符号，转小写。
 * 用于跨标点差异匹配（源站存「摔跤吧!爸爸」而用户搜「摔跤吧！爸爸」）。
 */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 仅将独立数字或明确的「第 N 季」后缀作为季数别名。
 *
 * `bareNeedsSpace` 区分两侧：
 * - 查询侧传 false：用户习惯直接输入「庆余年2」，数字前没有空格也得认成季数
 * - 标题侧保持 true：必须有空格，避免把片名自带的数字（「电影2」）误判成第二季
 */
function parseSeasonSuffix(
  title: string,
  allowAnnotations = false,
  bareNeedsSpace = true
): { base: string; season: number; explicit: boolean } | undefined {
  // 标题侧允许「第二季」后跟任意附注：粤语、预告片、【影视解说】、无分隔符的「第二季粤语」都算
  const explicitPattern = allowAnnotations
    ? /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季.*$/u
    : /^(.*?)\s*第\s*([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*季$/u;
  const explicit = title.trim().match(explicitPattern);
  const bare = title.trim().match(bareNeedsSpace ? /^(.*?)\s+([1-9]\d?)$/u : /^(.*?)\s*([1-9]\d?)$/u);
  const match = explicit ?? bare;
  if (!match || !normalizeTitle(match[1])) return undefined;
  const value = match[2];
  const digits = '零一二三四五六七八九';
  let season = Number(value);
  if (!Number.isFinite(season)) {
    const chinese = value.replace('两', '二');
    if (/^[一二三四五六七八九]$/u.test(chinese)) {
      season = digits.indexOf(chinese);
    } else if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(chinese)) {
      const [tens, units] = chinese.split('十');
      season = (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
    }
  }
  if (!Number.isFinite(season)) return undefined;
  return { base: match[1], season, explicit: Boolean(explicit) };
}

/** 数字必须完整命中，避免第 2 季误匹配 12 或 20。 */
function includesKeyword(title: string, keyword: string): boolean {
  if (!title || !keyword) return false;
  let index = title.indexOf(keyword);
  while (index >= 0) {
    const before = title[index - 1] ?? '';
    const after = title[index + keyword.length] ?? '';
    if ((!/^\d/u.test(keyword) || !/\d/u.test(before)) &&
        (!/\d$/u.test(keyword) || !/\d/u.test(after))) return true;
    index = title.indexOf(keyword, index + 1);
  }
  return false;
}

/**
 * 关键词只解析一次。
 * filterRelevantResults 会对同一个查询过滤几百上千条结果，
 * 关键词的归一化、季数解析、分词结果对每条都相同，没必要重复算。
 */
interface PreparedQuery {
  normalized: string;
  season?: { base: string; season: number; explicit: boolean };
  tokens: string[];
}

function prepareQuery(wd: string): PreparedQuery | undefined {
  const normalized = normalizeTitle(wd);
  if (!normalized) return undefined;
  return {
    normalized,
    // 查询侧允许「庆余年2」这种无空格写法
    season: parseSeasonSuffix(wd, false, false),
    tokens: wd.trim().split(/\s+/).map(normalizeTitle).filter(Boolean),
  };
}

function matchesPrepared(nName: string, query: PreparedQuery): boolean {
  if (includesKeyword(nName, query.normalized)) return true;
  return query.tokens.length > 1 && query.tokens.every((token) => includesKeyword(nName, token));
}

function isRelevantPrepared(name: string, query: PreparedQuery): boolean {
  const nName = normalizeTitle(name);
  if (!nName) return false;
  const titleSeason = parseSeasonSuffix(name, true);
  if (query.season && titleSeason) {
    if (query.season.season !== titleSeason.season) return false;
    if (query.season.explicit || titleSeason.explicit) {
      const baseQuery = prepareQuery(query.season.base);
      if (baseQuery) return matchesPrepared(normalizeTitle(titleSeason.base), baseQuery);
    }
  }
  return matchesPrepared(nName, query);
}

/**
 * 忽略标点和大小写，多词查询要求每个词都命中。
 * 独立的末尾数字也可匹配明确的中文季数后缀；
 * 标题内部的数字与四位年份不作为季数别名。
 */
export function isRelevant(name: string, wd: string): boolean {
  const query = prepareQuery(wd);
  if (!query) return true;
  return isRelevantPrepared(name, query);
}

/** 丢弃无关结果；即使全部不相关，也不能返回源站的原始目录。 */
export function filterRelevantResults<T extends { name?: string }>(items: T[], wd: string): T[] {
  const query = prepareQuery(wd);
  if (!query) return items;
  // 严格命中之外再放行「近似命中」：源站标题里的错别字/形近字不该让整条结果消失，
  // 但它们在排序里是最后一档（见 lib/relevance.ts），不会挤掉真正对得上的条目
  return items.filter(
    (item) => isRelevantPrepared(item.name || '', query) || isApproximatelyRelevantPrepared(item.name || '', query)
  );
}

/**
 * 近似命中（错别字/形近字级别）。
 *
 * 单独一个函数而不是并进 `isRelevant`：后者是严格的「包含 / 全 token」语义，
 * 已有调用方与单测依赖它判断「够不够格」，放宽会让「钢铁侠」被当成
 * 「钢铁侠 2008」的命中。
 */
function isApproximatelyRelevantPrepared(name: string, query: PreparedQuery): boolean {
  // 查询带季数时不做近似：第二季不能因为标题像第一季就混进来
  if (query.season) return false;
  const normalized = normalizeTitle(name);
  if (!normalized) return false;
  return isCloseMatch(normalized, query.normalized);
}

export function isApproximatelyRelevant(name: string, wd: string): boolean {
  const query = prepareQuery(wd);
  return query ? isApproximatelyRelevantPrepared(name, query) : false;
}
