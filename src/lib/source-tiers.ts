import type { SourceConfig } from './types';

export interface SearchSourceTierPlan {
  /** 首轮查询的精选主力源 */
  tier1: SourceConfig[];
  /** 用户点击「搜索更多源」后才查询的长尾源 */
  tier2: SourceConfig[];
  /** false 表示用户有显式源配置，首轮保持其完整选择 */
  tiered: boolean;
}

interface SourceTierInput {
  /** 已按勾选、订阅开关和健康度过滤后的本轮可搜索源 */
  activeSources: SourceConfig[];
  envSources: SourceConfig[];
  selectedKeys: readonly string[];
  customSourceCount: number;
  yellowFilter: boolean;
  sourceSelectionTouched: boolean;
}

/**
 * 只有「出厂预置源 + 从未手动改选」才启用分层。
 *
 * 老版本没有 touched 标记，因此再用选中集合兜底识别： legacy 用户只要取消过
 * 任意预置源，当前集合就与自动勾选结果不同，仍按显式配置处理，不会被静默改成 8 源。
 */
export function isDefaultSourceSelection({
  envSources,
  selectedKeys,
  customSourceCount,
  yellowFilter,
  sourceSelectionTouched,
}: Omit<SourceTierInput, 'activeSources'>): boolean {
  if (sourceSelectionTouched || customSourceCount > 0 || envSources.length === 0) return false;

  const expected = new Set(
    envSources.filter((source) => !source.isAdult || !yellowFilter).map((source) => source.key)
  );
  const envKeys = new Set(envSources.map((source) => source.key));
  const actual = new Set(selectedKeys);
  if (actual.size !== expected.size) return false;
  for (const key of actual) {
    if (!envKeys.has(key) || !expected.has(key)) return false;
  }
  return true;
}

/** 默认首轮只查 Tier 1；任何显式配置、异常空档都退回完整选择，避免无源可搜。 */
export function planSearchSourceTiers(input: SourceTierInput): SearchSourceTierPlan {
  const all = { tier1: input.activeSources, tier2: [], tiered: false };
  if (!isDefaultSourceSelection(input)) return all;

  const tier1 = input.activeSources.filter((source) => source.tier === 1);
  const tier2 = input.activeSources.filter((source) => source.tier !== 1);
  if (tier1.length === 0 || tier2.length === 0) return all;
  return { tier1, tier2, tiered: true };
}
