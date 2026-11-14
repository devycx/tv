/**
 * 字符串相似度工具（纯函数，便于单测）。
 *
 * 调用方负责先把字符串归一化（去空白/标点/大小写），本模块不再重复处理：
 * 归一化规则只应有一份（cms-parser 的 normalizeTitle），否则排序和过滤会各算各的。
 *
 * 用途有两个：
 * - 搜索过滤：宁可漏掉一个错别字结果，也不要把「戒色」混进「色戒」；
 * - 相关性打分：近似命中排在精确/包含命中之后。
 */

/** 标准 Levenshtein 距离（滚动数组，O(min(a,b)) 空间） */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[b.length];
}

/** 双字组 Dice 系数（中文没有空格，按 2-gram 切比按字符编辑距离更贴近语感） */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;

  const grams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  const pool = new Map<string, number>();
  for (const g of right) pool.set(g, (pool.get(g) ?? 0) + 1);

  let hit = 0;
  for (const g of left) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (left.length + right.length);
}

/**
 * 是否算「近似同一部片」（错别字级别），已归一化输入。
 *
 * 阈值刻意保守：
 * - 短于 3 个字符不做近似——「色戒」↔「戒色」只差一次交换，放开就等于没有过滤；
 * - 长度差超过允许编辑数时，只有双字组高度重合（≥0.8）才认；
 * - 否则编辑距离 ≤ 1（≥8 字符放宽到 2）或双字组 ≥ 0.75。
 */
export function isCloseMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const short = Math.min(a.length, b.length);
  const long = Math.max(a.length, b.length);
  if (short < 3) return false;

  const allowed = short >= 8 ? 2 : 1;
  if (long - short > allowed) return diceCoefficient(a, b) >= 0.8;
  if (levenshtein(a, b) <= allowed) return true;
  return diceCoefficient(a, b) >= 0.75;
}
