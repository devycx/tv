/**
 * 搜索结果翻页时的顺序稳定化（纯函数，便于单测）。
 *
 * 背景：搜索结果不是一个「分页接口」，而是服务端一次性返回、客户端切片渲染；
 * 流式搜索期间列表会随每个源结算而重建，`done` 时还会整体按相关性重排。
 * 用户翻过页之后如果还跟着重排，正在看的卡片会被顶走——翻得越深越难受。
 *
 * 策略：翻页时把当前顺序「冻结」成 key 列表；之后的新列表按冻结顺序重排，
 * 未见过的新条目追加到尾部。组内容仍取最新（同名来源会继续追加），只冻结顺序。
 * 想拿回相关性顺序时，由用户点「重新排序」显式触发（见页面里的提示条）。
 */

/** 按冻结的 key 顺序重排；冻结列表里已不存在的条目丢弃，新条目按传入顺序追加 */
export function applyFrozenOrder<T extends { key: string }>(groups: T[], frozenKeys: readonly string[]): T[] {
  const byKey = new Map<string, T>();
  for (const group of groups) byKey.set(group.key, group);

  const out: T[] = [];
  const seen = new Set<string>();
  for (const key of frozenKeys) {
    const group = byKey.get(key);
    if (!group || seen.has(key)) continue;
    out.push(group);
    seen.add(key);
  }
  for (const group of groups) {
    if (seen.has(group.key)) continue;
    out.push(group);
  }
  return out;
}

/** 两个列表的 key 顺序是否不同（长度或任一位置不一致）；用于决定要不要提示「重新排序」 */
export function orderDiffers<T extends { key: string }>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key) return true;
  }
  return false;
}
