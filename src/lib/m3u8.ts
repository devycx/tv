/**
 * m3u8 处理：相对地址锚定与广告分片过滤。
 *
 * 播放与下载都直连源站：本模块不再改写任何代理地址，媒体字节不经过本站。
 */

/**
 * 文档基址：把本站根相对地址锚成绝对地址时使用。
 * `new URL(相对串, 相对基址)` 在基址也是相对形式时必然抛错、只能原样返回，
 * 于是同一个分片在预取侧与播放器侧会是两个不同的字符串。SSR 下没有
 * document，返回 undefined，由调用方按「无法锚定」降级处理。
 */
export function documentBaseURI(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.baseURI;
}

export function makeAbsolute(url: string, base: string | undefined): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** DISCONTINUITY 标记行判定（广告剔除的几段逻辑共用，避免各函数重复定义） */
function isDisc(l: string): boolean {
  return l.trim() === '#EXT-X-DISCONTINUITY';
}

/** 分片行判定：非空且非注释行 */
function isSegment(l: string): boolean {
  const t = l.trim();
  return t !== '' && !t.startsWith('#');
}

/**
 * 片头广告段判定上限。dytt 等采集站把固定一支广告（约 15-60s，10 片左右）
 * 作为首个 DISCONTINUITY 段混入所有视频；正片分段（每段 20-40s）与其结构相同，
 * 只能靠「位于片头 + 短小 + 之后仍有分段」这三个特征保守区分，超限即不动。
 */
const LEAD_AD_MAX_SECONDS = 90;
const LEAD_AD_MAX_SEGMENTS = 20;

/**
 * 剔除 m3u8 片头插入的广告段（整段移除分片，而不是像旧实现那样删除
 * #EXT-X-DISCONTINUITY 标记——实测 dytt 源每段 PTS 基准独立跳变，删标记会让
 * hls.js 把整条流当连续时间轴，视频丢帧、音频错位，出现「只闻广告声不见其画面」）。
 *
 * 保守判定（全部满足才剔除）：
 * 0. 多分组封装下片头组与其余组同构时跳过（分组多且片头组大小≈其余组中位数 ⇒ 封装边界，以免误杀）；
 * 1. 首个分片之前存在 DISCONTINUITY（存在「片头插入段」结构）；
 * 2. 该段以下一个 DISCONTINUITY 结束，且其后仍有分段（否则无法与正片区分）；
 * 3. 段时长 ≤ 90s 且分片数 ≤ 20。
 *
 * 段内的 EXT-X-KEY / EXT-X-MAP 保留：若正片复用该解密/初始化配置，误删会导致
 * 无法解密；多声明一个 KEY 无副作用。剔除后新开头的 DISCONTINUITY（首分片之前
 * 没有「前文」）一并清掉。
 */
export function stripLeadAdGroup(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');

  // 多分组封装（采集站把流按固定块切分、每个衔接处都打 DISCONTINUITY）不是广告。
  // 实测两类源均在片头误删过正片：rycjapi 每组 5 片（间隙完全均匀），
  // dytt 每组多为 5 片但偶有 10/15/20 片长组（间隙不均匀，均匀性判据失灵）。
  // 两者的共性是：片头组与其余分组同构（大小一致），任何启发式都无法区分——
  // 这种情况下跳过片头剔除。仅当片头组大小明显异于其余组的中位数（疑似真插入段）才继续。
  const discIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);
  if (discIdx.length >= 4) {
    const groupSize = (from: number, to: number) => {
      let seg = 0;
      for (let k = from; k < to; k++) if (isSegment(lines[k])) seg += 1;
      return seg;
    };
    const leadSize = groupSize(discIdx[0] + 1, discIdx[1]);
    const others: number[] = [];
    for (let g = 1; g < discIdx.length; g++) {
      others.push(groupSize(discIdx[g] + 1, g + 1 < discIdx.length ? discIdx[g + 1] : lines.length));
    }
    const sorted = [...others].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // 与中位数偏差在阈值内视为同构（阈值下限 3 片，避免小分组时过度敏感）
    const typical = Math.abs(leadSize - median) <= Math.max(3, median * 0.5);
    if (typical) return m3u8Content; // 片头组与其余组无异 ⇒ 封装边界，跳过片头剔除
  }

  const firstDisc = discIdx[0];
  if (firstDisc === undefined) return m3u8Content;
  if (lines.slice(0, firstDisc).some(isSegment)) return m3u8Content;

  const nextDisc = discIdx.slice(1).find((i) => i > firstDisc);
  if (nextDisc === undefined) return m3u8Content;

  let seconds = 0;
  let count = 0;
  for (let i = firstDisc + 1; i < nextDisc; i++) {
    const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
    if (m) seconds += parseFloat(m[1]) || 0;
    else if (isSegment(lines[i])) count += 1;
  }
  if (count === 0 || count > LEAD_AD_MAX_SEGMENTS) return m3u8Content;
  if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return m3u8Content;

  const kept = lines.filter((l, i) => {
    if (i < firstDisc || i >= nextDisc) return true;
    const t = l.trim();
    return t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP');
  });
  const out: string[] = [];
  let seenSegment = false;
  for (const l of kept) {
    if (!seenSegment && isDisc(l)) continue;
    if (isSegment(l)) seenSegment = true;
    out.push(l);
  }
  return out.join('\n');
}

/**
 * 广告分片 URL 特征。暴风等采集云把中插广告放在明显的路径里
 * （实测：`/video/adjump/time/….ts`，"adjump" = ad jump），与正片分片
 * 的命名完全不同——这是比时长/位置可靠得多的识别信号。
 */
const AD_URL_PATTERN = /adjump|advert|\/ads?\//i;

function looksLikeAdUrl(line: string): boolean {
  return AD_URL_PATTERN.test(line.trim());
}

/**
 * 按 URL 特征剔除任意位置的 DISCONTINUITY 广告段（片头/中插均覆盖）。
 * 保守判定：段内**全部分片**都命中广告 URL 特征才整段剔除——只要混入一个
 * 正片分片就放过，避免按时长猜测带来的误伤（正常分段与中插广告时长重叠）。
 * 剔除时保留段前那个 DISCONTINUITY 作正片分段边界，因此不会出现双标记；
 * 段内 EXT-X-KEY / EXT-X-MAP 与片头逻辑同理保留。
 */
function stripMarkedAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');

  const drop = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let count = 0;
    let allAd = true;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        count += 1;
        if (!looksLikeAdUrl(lines[j])) allAd = false;
      }
      j += 1;
    }
    if (count > 0 && allAd) {
      drop[i] = true;
      for (let k = i + 1; k < j; k++) {
        const t = lines[k].trim();
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
        drop[k] = true;
      }
    }
    i = j;
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/**
 * 中插广告段的时长判定阈值。dytt 式源（正片段本身就 15~40s 交替）绝不能
 * 触发本规则，因此除了「段超短」还要求「前后邻段都足够长」——两长夹一短
 * 才视为插入广告（实测 phimgood 源：298s/1198s/2163s/1737s/588s 长正片段
 * 之间夹 4 个 15~19s 广告段）。
 */
const INTERSTITIAL_MAX_SECONDS = 30;
const INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120;
/**
 * 片尾短广告的最小总时长。不能只按「最后一个 DISCONTINUITY 段 ≤ 30s」判定：
 * 大量采集源把正片按 1~4s 密集切片，最后一组常常只有 1 个几秒的尾巴
 * （实测柯南源：312 个 1s 分片 + 结尾 0000312.ts），按宽口径会把正片尾巴删掉。
 * 贴片广告实测为 15~30s，这里要求下限 15s，低于它的尾段一律放过。
 */
const INTERSTITIAL_TAIL_MIN_SECONDS = 15;

interface AdGroupScan {
  /** 组内容行区间 [start, end)，不含组前的 DISCONTINUITY 行 */
  start: number;
  end: number;
  /** 组前 DISCONTINUITY 行下标（首组为 -1） */
  discLine: number;
  seconds: number;
  count: number;
}

/** 按 DISCONTINUITY 把播放列表切成组：组 k（k≥1）前的边界行是 discIdx[k-1] */
function scanGroups(lines: string[]): AdGroupScan[] {
  const discIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);

  const groups: AdGroupScan[] = [];
  const bounds = [0, ...discIdx, lines.length];
  for (let k = 0; k < bounds.length - 1; k++) {
    // 组 0 从文件头开始；组 k（k≥1）跳过作为边界的 DISCONTINUITY 行
    const start = k === 0 ? 0 : bounds[k] + 1;
    const end = bounds[k + 1];
    let seconds = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
      if (m) seconds += parseFloat(m[1]) || 0;
      else if (isSegment(lines[i])) count += 1;
    }
    groups.push({ start, end, discLine: k === 0 ? -1 : bounds[k], seconds, count });
  }
  return groups;
}

/**
 * 剔除「长正片段之间的超短插入段」与「片尾贴片短广告」（URL 无特征的纯时长型广告）。
 * 判定：
 * - 中插：段时长 ≤ 30s，且前后邻段时长都 ≥ 120s；
 * - 片尾：最后一个 DISCONTINUITY 段时长 15~30s、分片数 ≤ 10，且前邻段 ≥ 120s
 *   （没有 next 邻段，无法沿用中插的「两长夹一短」判据，只能靠位置 + 短小）。
 * 基于原始分组一次性评估，不级联；dytt 式「全片都是短段」的源因邻段不满足长段条件
 * 而完全不触发。首组交由片头启发式处理，本函数只看 k ≥ 1 的组。
 */
function stripInterstitialAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');

  const groups = scanGroups(lines);
  const drop = new Array<boolean>(lines.length).fill(false);
  for (let k = 1; k < groups.length; k++) {
    const g = groups[k];
    const prev = groups[k - 1];
    const next = groups[k + 1];
    if (g.count === 0 || g.discLine < 0) continue;
    if (g.seconds <= 0 || g.seconds > INTERSTITIAL_MAX_SECONDS) continue;
    if (!prev || prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    // 中插段要求前后邻段均 >= 120s；片尾最末段（!next）要求前邻段 >= 120s、
    // 总时长 >= 15s 且分片数 <= 10（几秒的正片尾巴不在判定范围内）
    const isValidMiddle = Boolean(next && next.seconds >= INTERSTITIAL_NEIGHBOR_MIN_SECONDS);
    const isValidTail =
      !next && g.seconds >= INTERSTITIAL_TAIL_MIN_SECONDS && g.count <= 10;
    if (!isValidMiddle && !isValidTail) continue;

    drop[g.discLine] = true;
    for (let i = g.start; i < g.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
      drop[i] = true;
    }
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/**
 * 提取分片行的目录前缀（去掉查询串与末尾文件名），用于识别「异源/异目录」插入的广告段。
 */
function segmentDirPrefix(rawLine: string): string {
  const clean = rawLine.trim().split('?')[0];
  const lastSlash = clean.lastIndexOf('/');
  return lastSlash >= 0 ? clean.slice(0, lastSlash + 1).toLowerCase() : '';
}

const ANOMALY_AD_MAX_SECONDS = 45;
const ANOMALY_AD_MAX_SEGMENTS = 15;
const DOMINANT_PREFIX_MIN_RATIO = 0.75;
const MIN_TOTAL_SEGMENTS_FOR_PREFIX_CHECK = 20;

/**
 * 按「分片目录前缀突变」剔除 DISCONTINUITY 广告段：
 * 当整条 m3u8 总分片数 >= 20 且存在单一主导目录前缀（占比 >= 75%）时，
 * 若某个带 DISCONTINUITY 边界的短分组（时长 <= 45s 且分片数 <= 15）内
 * 100% 的分片目录前缀均不等于主导前缀，则判定为异源插入广告并整段剔除。
 *
 * 针对 dytt 式「每组 5~15 片、每块仅 20~40s」的采集源：邻段不够长时
 * stripInterstitialAdGroups 不触发，但广告分片往往落在完全不同的目录
 * （正片 `/20261116/xyz_main/0001.ts`，广告 `/upload/tuiguang/a1.ts`）。
 * 没有目录的分片（如 `0001.ts`）前缀为空串，不参与判定，避免误杀。
 */
export function stripPrefixAnomalyAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const groups = scanGroups(lines);
  if (groups.length < 2) return m3u8Content;

  const prefixCounts = new Map<string, number>();
  let totalSegments = 0;
  for (const line of lines) {
    if (!isSegment(line)) continue;
    totalSegments += 1;
    const prefix = segmentDirPrefix(line);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  if (totalSegments < MIN_TOTAL_SEGMENTS_FOR_PREFIX_CHECK) return m3u8Content;

  let dominantPrefix = '';
  let dominantCount = 0;
  for (const [prefix, count] of prefixCounts) {
    if (count > dominantCount) {
      dominantPrefix = prefix;
      dominantCount = count;
    }
  }
  if (!dominantPrefix || dominantCount / totalSegments < DOMINANT_PREFIX_MIN_RATIO) {
    return m3u8Content;
  }

  const drop = new Array<boolean>(lines.length).fill(false);
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    if (g.count === 0 || g.count > ANOMALY_AD_MAX_SEGMENTS) continue;
    if (g.seconds <= 0 || g.seconds > ANOMALY_AD_MAX_SECONDS) continue;
    // 首组若无前置 DISCONTINUITY，必须确保其后存在 DISCONTINUITY 边界
    if (k === 0 && groups.length < 2) continue;

    let allForeign = true;
    for (let i = g.start; i < g.end; i++) {
      if (!isSegment(lines[i])) continue;
      if (segmentDirPrefix(lines[i]) === dominantPrefix) {
        allForeign = false;
        break;
      }
    }
    if (!allForeign) continue;

    if (g.discLine >= 0) drop[g.discLine] = true;
    for (let i = g.start; i < g.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
      drop[i] = true;
    }
  }

  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/** 清除首个分片之前的 DISCONTINUITY：其前没有媒体内容，标记无语义（hls.js 的 cc 从 0 开始） */
function stripLeadingDisc(content: string): string {
  const lines = content.split('\n');
  const firstSeg = lines.findIndex((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (firstSeg <= 0) return content;
  const kept = lines.filter((l, i) => !(i < firstSeg && l.trim() === '#EXT-X-DISCONTINUITY'));
  return kept.length === lines.length ? content : kept.join('\n');
}

/**
 * 广告过滤总入口（播放 loader 与下载解析共用），按可靠性依次：
 * 1. URL 关键字特征中插段（adjump 等，任意位置）；
 * 2. 目录前缀突变短插入段（异域/异目录广告段）；
 * 3. 长正片段之间的超短插入段（纯时长型中插/片尾广告）；
 * 4. 片头无特征插入段（dytt 式，位置+短小启发式）；
 * 最后统一清掉首分片前失去语义的 DISCONTINUITY。
 */
export function stripAdGroups(m3u8Content: string): string {
  if (!m3u8Content) return '';
  return stripLeadingDisc(
    stripLeadAdGroup(
      stripInterstitialAdGroups(
        stripPrefixAnomalyAdGroups(
          stripMarkedAdGroups(m3u8Content)
        )
      )
    )
  );
}
