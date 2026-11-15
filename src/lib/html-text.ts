/**
 * CMS 富文本清洗：把苹果CMS 的 `vod_content`（编辑器产出的 HTML）转成可读纯文本。
 *
 * 背景：不少源站把公众号排版直接塞进 `vod_content`，整段是
 * `<p><span style="color: rgb(17, 17, 17); font-family: Helvetica, ...">正文</span></p>`。
 * 详情弹窗把它当文本节点渲染，用户看到的就是 3 行 CSS 属性（2026-11 线上反馈）。
 *
 * 为什么在服务端洗：`/api/detail` 有 60s 缓存，洗一次之后缓存和客户端拿到的都是干净的，
 * 以后 watch 页/换源预览复用 `videoInfo.desc` 时不必各自再洗一遍。
 *
 * 刻意不做的事：
 * - 不还原 HTML 结构、不保留内联样式：内容来自第三方源站，`color: rgb(17,17,17)` +
 *   `background: #fff` 这类样式在暗色主题下会变成一块白底黑字；`<img>/<script>` 也不该进 UI。
 * - 不做递归实体解码：源站若二次转义成 `&lt;p&gt;`，解一层就够了；递归解码会重新长出
 *   可执行标记（React 虽然会转义，但没必要留这个面）。
 */

/**
 * 块级标签与 `<br>` 一律按「段落边界」处理（换两行，归一后是空行）。
 * 源站里两者都在用来分段：正规 CMS 用 `<p>`，公众号排版导出用 `<span>…</span><br/>`。
 * 统一按段落处理，展开后段与段之间才有清晰的空行。
 */
const BLOCK_TAG_RE =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dd|dt|tr|td|th|table|thead|tbody|tfoot|h[1-6]|section|article|aside|blockquote|figure|figcaption|pre|address|header|footer|nav|main)\b[^>]*>/gi;

const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** 连同内容一起丢：这些标签里的文本是代码，不是给人读的 */
const DROPPED_BLOCK_RE = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** 剩下的行内标签（span/b/strong/a/font…）直接去掉，不插空格：中文被标签切词时插空格反而读不通 */
const ANY_TAG_RE = /<\/?[a-z][^>]*>/gi;

const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi;

/** 只收常见实体；未命中的保持原样（宁可见 `&foo;`，也不要猜错） */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  emsp: ' ',
  ensp: ' ',
  thinsp: ' ',
  shy: '',
  zwnj: '',
  zwj: '',
};

/** 单次解码：数字实体 + 常见命名实体 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * 空白归一：段内多空格压成一个，段间最多留一个空行，行首行尾（含全角空格）去掉。
 * 保留 `\n` 是为了「展开」后还能看到分段，UI 用 `whitespace-pre-line` 呈现。
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
    .join('\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 默认上限：正常剧情简介远小于此；防的是个别源把整页正文/导航塞进 vod_content */
const DEFAULT_MAX_LENGTH = 2000;

/**
 * `vod_content` → 纯文本。空内容（只有标签/图片）返回 `''`，调用方据此决定是否渲染。
 *
 * @param html 原始 HTML（undefined/null 安全）
 * @param maxLength 截断上限，超出部分以 `…` 结尾
 */
export function stripHtmlToText(html: string | null | undefined, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!html) return '';

  let text = html
    .replace(COMMENT_RE, '')
    .replace(DROPPED_BLOCK_RE, '')
    .replace(BLOCK_TAG_RE, '\n\n')
    .replace(ANY_TAG_RE, '');

  text = normalizeWhitespace(decodeHtmlEntities(text));

  if (text.length > maxLength) {
    let cut = text.slice(0, maxLength);
    // 别把代理对切成半个字符
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    text = `${cut.trimEnd()}…`;
  }
  return text;
}
