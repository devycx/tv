import type { LiveSourceConfig, SourceConfig } from './types';

/**
 * 首屏引导数据：部署者预置源等静态配置。
 *
 * 由 `scripts/gen-wrangler.mjs` 在**构建期**生成 `bootstrap.generated.json`，
 * 根 layout 静态导入后内联进首屏 HTML，客户端据此初始化认证状态与预置源，
 * 页面加载**不再请求 `/api/status`**。
 *
 * 注意：不能用「请求期读 process.env + connection()」实现——那会让所有页面变成
 * 动态 SSR，实测页面 CPU 从 ~20ms 涨到 300ms+，直接撞免费版 10ms CPU 配额。
 * 因此改源后需要重新 `npm run cf:build`（脚本会自动重跑 gen-wrangler）。
 *
 * 刻意不包含 `verified`：middleware 保证能渲染受保护页面的请求一定已登录、
 * 能渲染 `/login` 的一定未登录，客户端按当前路由即可判定（见 providers.tsx）。
 */
export interface BootstrapConfig {
  /** 应用版本（构建时由 next.config.ts 从 package.json 注入） */
  version: string;
  /** 部署者是否配置了 PASSWORD（未配置时 UI 提示管理员配置） */
  passwordRequired: boolean;
  /** 部署者通过 DEFAULT_SOURCES 预置的采集站 */
  defaultSources: SourceConfig[];
  /** 部署者通过 DEFAULT_LIVE_SOURCES 预置的直播源（M3U 订阅） */
  defaultLiveSources: LiveSourceConfig[];
  /** 部署者通过 DEFAULT_SUBSCRIPTIONS 预置的 SourceList 订阅链接 */
  defaultSubscriptions: { url: string; name?: string; refreshDays?: number }[];
  /** 部署者通过 DEFAULT_RECOMMEND_SOURCE 指定的首页推荐数据源默认值（未配置为 null） */
  defaultRecommendSource: 'douban' | 'bangumi' | 'hot-list' | null;
  /** 部署者通过 DEFAULT_IMAGE_MODE 指定的封面图加载方式默认值（未配置为 null） */
  defaultImageMode: 'direct' | 'proxy' | null;
}
