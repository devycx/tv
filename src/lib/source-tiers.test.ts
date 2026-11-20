import { describe, expect, it } from 'vitest';
import { isDefaultSourceSelection, planSearchSourceTiers } from './source-tiers';
import type { SourceConfig } from './types';

const sources: SourceConfig[] = [
  { key: 'env_0', name: '主力一', url: 'https://a.example/api', tier: 1 },
  { key: 'env_1', name: '主力二', url: 'https://b.example/api', tier: 1 },
  { key: 'env_2', name: '长尾一', url: 'https://c.example/api' },
  { key: 'env_3', name: '长尾二', url: 'https://d.example/api', tier: 2 },
  { key: 'env_4', name: '成人', url: 'https://e.example/api', isAdult: true },
];
const base = {
  envSources: sources,
  selectedKeys: sources.map((source) => source.key),
  customSourceCount: 0,
  yellowFilter: false,
  sourceSelectionTouched: false,
};

describe('planSearchSourceTiers', () => {
  it('出厂默认只查 Tier 1，其余按需扩搜', () => {
    const plan = planSearchSourceTiers({ ...base, activeSources: sources });
    expect(plan.tiered).toBe(true);
    expect(plan.tier1.map((source) => source.key)).toEqual(['env_0', 'env_1']);
    expect(plan.tier2.map((source) => source.key)).toEqual(['env_2', 'env_3', 'env_4']);
  });

  it('用户主动改过选源：完整选择优先，不擅自缩成 8 个源', () => {
    const plan = planSearchSourceTiers({
      ...base,
      activeSources: sources,
      sourceSelectionTouched: true,
    });
    expect(plan).toEqual({ tier1: sources, tier2: [], tiered: false });
  });

  it('老用户没有 touched 标记，但取消过源：按显式配置保留全部', () => {
    expect(
      isDefaultSourceSelection({
        ...base,
        selectedKeys: sources.filter((source) => source.key !== 'env_3').map((source) => source.key),
      })
    ).toBe(false);
  });

  it('存在自定义源或订阅时不做分层', () => {
    expect(isDefaultSourceSelection({ ...base, customSourceCount: 1 })).toBe(false);
    expect(
      planSearchSourceTiers({ ...base, activeSources: sources, customSourceCount: 1 }).tiered
    ).toBe(false);
  });

  it('成人过滤状态与自动勾选集合一致时仍可分层', () => {
    expect(
      isDefaultSourceSelection({
        ...base,
        yellowFilter: true,
        selectedKeys: sources.filter((source) => !source.isAdult).map((source) => source.key),
      })
    ).toBe(true);
  });

  it('没有 Tier 1 或没有 Tier 2 时退回完整选择，避免首轮无源可搜', () => {
    const allTier2 = sources.map((source) => ({ ...source, tier: 2 as const }));
    expect(
      planSearchSourceTiers({
        ...base,
        envSources: allTier2,
        activeSources: allTier2,
      }).tiered
    ).toBe(false);
  });

  it('健康度过滤后的活跃源仍按原层级切分', () => {
    const active = sources.filter((source) => source.key !== 'env_0');
    const plan = planSearchSourceTiers({ ...base, activeSources: active });
    expect(plan.tier1.map((source) => source.key)).toEqual(['env_1']);
  });
});
