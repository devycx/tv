'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { RecommendSection } from '@/components/douban-section';
import { DetailModal } from '@/components/detail-modal';
import { AggregatedCard } from '@/components/video-card';
import { useAppStore, resolveSource, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { api } from '@/lib/client-api';
import type { SearchResultItem } from '@/lib/types';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { cn, buildWatchUrl, validateSourceUrl } from '@/lib/utils';
import { addSearchHistory } from '@/lib/db';
import { applyFrozenOrder, orderDiffers } from '@/lib/result-paging';
import { aggregateResults, mergeExpandedGroups } from '@/lib/search-groups';
import { planSearchSourceTiers } from '@/lib/source-tiers';
import {
  EMPTY_FILTERS,
  buildFacets,
  filterGroups,
  hasActiveFilters,
  type FacetOption,
  type SearchFacets,
  type SearchFilters,
} from '@/lib/search-facets';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';

/**
 * 首页：搜索（URL ?s= 驱动，可后退/分享）+ 豆瓣推荐。
 * 搜索状态由 React Query 管理；失败的源静默跳过（不提示），健康度只在设置里看。
 */
/**
 * 搜索结果每页条数。
 * 实测（35 个源）：片名搜索普遍 10–35 部，只有「年份 / 单字」这类宽查询才会超过一页，
 * 所以 24 足够覆盖绝大多数查询；一次挂太多卡片会让流式阶段每个源结算都整页重渲染。
 */
const RESULT_PAGE_SIZE = 24;

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const urlQuery = searchParams.get('s') || '';
  // 精确订阅所需字段（对齐 live 页的做法）：搜索流式期间逐源写健康度、
  // 打开设置抽屉/历史面板等无关 store 变化，都不应触发首页整树重渲染
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const searchTimeoutMs = useAppStore((s) => s.searchTimeoutMs);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const sourceSelectionTouched = useAppStore((s) => s.sourceSelectionTouched);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const [input, setInput] = useState(urlQuery);
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  /** 记录用户主动扩搜的是哪一轮查询；换关键词/源配置后自动失效，无需清理在途状态 */
  const [expandScope, setExpandScope] = useState<string | null>(null);
  /** 结果标签筛选（类型 / 年份 / 18禁）；查询变化时清空 */
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const inputRef = useRef<HTMLInputElement>(null);

  // URL 驱动搜索：?s= 变化时回填输入框
  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  const selectedSources = useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      // 自动停用期内的源不参与搜索（到期自动恢复）
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      // 所属订阅被整体停用的源同样跳过（无损：各源勾选状态保留，重新启用即恢复）
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);

  const sourceTiers = useMemo(
    () =>
      planSearchSourceTiers({
        activeSources: selectedSources,
        envSources,
        selectedKeys,
        customSourceCount: customAPIs.length,
        yellowFilter,
        sourceSelectionTouched,
      }),
    [selectedSources, envSources, selectedKeys, customAPIs.length, yellowFilter, sourceSelectionTouched]
  );
  const expandedSourceKeys = useMemo(() => sourceTiers.tier2.map((source) => source.key), [sourceTiers]);
  /**
   * 查询身份只取用户选择，不取实时健康度：逐源回调会写 sourceHealth，
   * 若把「当前可用源 key」放进 queryKey，一个源刚被判失败就会取消并重启整轮搜索。
   */
  const expansionScope = JSON.stringify([
    urlQuery,
    selectedKeys,
    customAPIs.length,
    envSources.length,
    sourceSelectionTouched,
    yellowFilter,
    searchTimeoutMs,
  ]);
  const expansionRequested = expandScope === expansionScope;

  const searchQuery = useQuery({
    queryKey: ['search', expansionScope],
    // 首轮 Tier 1 整批结算后一次上屏；逐源事件只更新健康度，不再驱动整页重排。
    queryFn: async ({ signal }) =>
      api.search(urlQuery.slice(0, 100), sourceTiers.tier1, yellowFilter, {
        signal,
        timeoutMs: searchTimeoutMs,
        onSource: (outcome) => useAppStore.getState().recordSourceHealth([outcome]),
      }),
    enabled: Boolean(urlQuery) && sourceTiers.tier1.length > 0,
    // 5 分钟内从播放页返回时直接使用缓存，不重新搜索（服务端另有 60s 结果缓存兜底）
    staleTime: 300_000,
  });

  const expandedQuery = useQuery({
    queryKey: ['search-more', expansionScope],
    queryFn: async ({ signal }) =>
      api.search(urlQuery.slice(0, 100), sourceTiers.tier2, yellowFilter, {
        signal,
        timeoutMs: searchTimeoutMs,
        onSource: (outcome) => useAppStore.getState().recordSourceHealth([outcome]),
      }),
    enabled: expansionRequested && Boolean(searchQuery.data) && sourceTiers.tier2.length > 0,
    staleTime: 300_000,
  });

  // 最近搜索改为搜索框下拉（聚焦展开、按输入过滤），不再常驻首屏
  const searchHistory = useSearchHistory(input);

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  /**
   * 点封面直达播放：不带集数，用 `index=last` 交给播放页决定——
   * 有本地进度就续播，没有则剧集取最新一集。搜索页不必先拉一次详情。
   * useCallback 稳定引用：配合 AggregatedCard 的 React.memo，输入框每敲一个字
   * 不会让整页卡片全部重渲染。
   */
  const playBest = useCallback(
    (item: SearchResultItem) => {
      addSearchHistory(item.name).catch(() => {});
      router.push(
        buildWatchUrl({
          sourceKey: item.sourceKey,
          vodId: item.vodId,
          title: item.name,
          sourceUrl: item.sourceUrl,
          index: 'last',
        })
      );
    },
    [router]
  );

  const openDetail = useCallback((item: SearchResultItem) => setDetailItem(item), []);

  const isSearching = Boolean(urlQuery) && searchQuery.isFetching && !searchQuery.data;
  const list = useMemo(() => searchQuery.data?.list ?? [], [searchQuery.data]);
  // 分批渲染：新一次搜索（查询/源选择/过滤条件变化）时重置回首批。
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const primaryGroups = useMemo(() => aggregateResults(list), [list]);
  const groups = useMemo(
    () =>
      expandedQuery.data
        ? mergeExpandedGroups(primaryGroups, expandedQuery.data.list)
        : primaryGroups,
    [primaryGroups, expandedQuery.data]
  );
  // 结果标签自动生成筛选项：只收集当前结果里出现过的类型 / 年份 / 18禁
  const facets = useMemo(() => buildFacets(groups, filters), [groups, filters]);
  const filteredGroups = useMemo(() => filterGroups(groups, filters), [groups, filters]);
  const filtersActive = hasActiveFilters(filters);
  /** 条数从聚合组统计，与结果头「N 条」口径一致 */
  const visibleSourceCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.items.length, 0),
    [groups]
  );
  const filteredSourceCount = useMemo(
    () => filteredGroups.reduce((sum, group) => sum + group.items.length, 0),
    [filteredGroups]
  );
  /**
   * 本次搜索里被「成人内容过滤」隐藏的相关条数。
   * 原来被过滤的结果静默消失，用户只看到空态，容易误判成「没有片源」。
   */
  const filteredAdultCount =
    (searchQuery.data?.filteredAdultCount ?? 0) + (expandedQuery.data?.filteredAdultCount ?? 0);

  /**
   * 翻过页之后冻结当前顺序：扩搜或筛选更新时，正在看的卡片不被顶走。
   * 扩搜本身已经在 mergeExpandedGroups 里冻结旧组，这里再兜住分页边界。
   */
  const [frozenKeys, setFrozenKeys] = useState<string[] | null>(null);
  const orderedGroups = useMemo(
    () => (frozenKeys ? applyFrozenOrder(filteredGroups, frozenKeys) : filteredGroups),
    [filteredGroups, frozenKeys]
  );
  const visibleGroups = useMemo(
    () => orderedGroups.slice(0, visibleCount),
    [orderedGroups, visibleCount]
  );
  // 冻结顺序与最新相关性顺序不一致时，给用户一个主动更新的入口
  const orderChanged = useMemo(
    () => Boolean(frozenKeys) && orderDiffers(orderedGroups, filteredGroups),
    [frozenKeys, orderedGroups, filteredGroups]
  );
  const resultsRef = useRef<HTMLElement | null>(null);
  // 换了关键词就回到「未筛选」：上一部片的类型/年份不该继续约束新结果
  useEffect(() => {
    setFilters(EMPTY_FILTERS);
  }, [urlQuery]);
  useEffect(() => {
    setVisibleCount(RESULT_PAGE_SIZE);
    setFrozenKeys(null);
  }, [urlQuery, expansionScope, filters]);

  const canExpand =
    sourceTiers.tiered && expandedSourceKeys.length > 0 && Boolean(searchQuery.data);
  const expandBusy = expansionRequested && expandedQuery.isFetching;
  const expandFailed = expansionRequested && expandedQuery.isError;
  const moreSourcesAction =
    canExpand && (!expansionRequested || expandBusy || expandFailed) ? (
      <button
        type="button"
        className="btn-ghost btn-sm"
        disabled={expandBusy}
        onClick={() => {
          if (expansionRequested) void expandedQuery.refetch();
          else setExpandScope(expansionScope);
        }}
      >
        {expandBusy
          ? '正在搜索更多源…'
          : expandFailed
            ? `重试搜索更多源（剩余 ${expandedSourceKeys.length} 个）`
            : `搜索更多源（剩余 ${expandedSourceKeys.length} 个）`}
      </button>
    ) : null;

  const loadMore = () => {
    // 先冻结再增加：这一批之后的任何重排都不再影响已渲染的卡片
    setFrozenKeys((prev) => prev ?? filteredGroups.map((g) => g.key));
    setVisibleCount((v) => v + RESULT_PAGE_SIZE);
  };

  const applyResort = () => {
    // 接受最新的相关性顺序，并回到结果区顶部——否则原地重排会让视线失去落点
    setFrozenKeys(filteredGroups.map((g) => g.key));
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggleFacet = (facet: 'types' | 'years', value: string) => {
    setFilters((prev) => {
      const next = new Set(prev[facet]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [facet]: [...next] };
    });
  };
  const clearFilters = () => setFilters(EMPTY_FILTERS);

  return (
    <div className="min-h-screen flex flex-col">
      <Header showBrand={Boolean(urlQuery)} />

      <main className="relative flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {/* 首屏氛围渐变 */}
        {!urlQuery && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] -z-10"
            style={{
              background:
                'radial-gradient(60% 60% at 50% 0%, rgba(35,173,229,0.10) 0%, rgba(35,173,229,0.03) 45%, transparent 75%)',
            }}
          />
        )}

        {/* 搜索区 */}
        <section className={cn('flex flex-col items-center', urlQuery ? 'mb-6' : 'mt-8 mb-8')}>
          {!urlQuery && (
            <header className="text-center mb-6">
              {/* 只展示网站名：slogan 已按需求移除 */}
              <h1 className="text-4xl sm:text-5xl font-bold brand-gradient">夜幕影视</h1>
            </header>
          )}
          {urlQuery && <h1 className="sr-only">夜幕影视 视频搜索</h1>}
          {/* 定位容器比胶囊宽一圈：浮层按它的宽度对齐，接缝处不会与胶囊边框错位 1px */}
          <div ref={searchHistory.containerRef} className="relative w-full max-w-2xl">
            <form
              className="w-full"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(input);
              }}
            >
              {/* 输入框与搜索按钮合并为一个胶囊：内部无边框，焦点态由容器统一表达；
                  下拉展开时改为「上圆下直」并隐去底边，与下方浮层拼成同一个面板 */}
              <div
                className={cn(
                  // 12px 圆角矩形（非胶囊）：收起态与展开态共用同一组上圆角，
                  // 展开时输入框这部分形状完全不发生变化，上下圆角也与下拉保持一致；
                  // 右侧与上下不留内边距，由搜索按钮拉伸填满、与搜索框边缘贴合
                  'flex items-stretch min-h-12 pl-4 border',
                  'transition-[background-color,border-color,border-radius] duration-200',
                  searchHistory.visible
                    ? // 展开时：外框（含上圆角）沿用输入框的聚焦样式不变，只把底边改为内部分隔线，
                      // 使输入区在展开状态下仍是边界清晰的独立输入框，而非与列表糊成一片
                      'rounded-t-xl rounded-b-none border-accent border-b-line bg-surface-raised'
                    : 'rounded-xl border-line bg-chip focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40'
                )}
              >
                <input
                  ref={inputRef}
                  className="flex-1 min-w-0 pr-2 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
                  placeholder="输入影片名称..."
                  value={input}
                  maxLength={100}
                  onChange={(e) => {
                    setInput(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-label="搜索影片"
                  aria-expanded={searchHistory.visible}
                  aria-controls="home-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `home-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {input && (
                  <button
                    type="button"
                    className="shrink-0 self-center mr-1 p-1.5 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                    onClick={() => {
                      setInput('');
                      searchHistory.resetActive();
                      inputRef.current?.focus();
                    }}
                    aria-label="清空"
                  >
                    <Icon name="close" className="w-4 h-4" />
                  </button>
                )}
                {/* 主操作按钮：贴合搜索框右端——右侧圆角跟随容器、左侧直角，展开时右下角
                    跟着容器一起改直角；按压改用亮度反馈（缩放会让贴合边缘露出缝隙） */}
                <button
                  type="submit"
                  className={cn(
                    'btn-primary shrink-0 px-4 font-medium transition-[background-color,filter] active:brightness-90',
                    '!rounded-l-none',
                    searchHistory.visible ? '!rounded-tr-xl !rounded-br-none' : '!rounded-r-xl'
                  )}
                >
                  <Icon name="search" className="w-4 h-4" />
                  搜索
                </button>
              </div>
            </form>

            {/* 最近搜索：与输入框无缝拼接；浮层不占文档流，出现/消失不会顶动下方内容 */}
            {searchHistory.visible && (
              <SearchHistoryDropdown
                id="home-search-history"
                matches={searchHistory.matches}
                activeIndex={searchHistory.activeIndex}
                onPick={pickHistory}
                onRemove={searchHistory.remove}
                onClearAll={searchHistory.clearAll}
              />
            )}
          </div>
          {/* 结果标签筛选：类型 / 年份 / 18禁，从当前结果自动收集，放在搜索框正下方 */}
          {urlQuery && (
            <SearchFacetBar
              facets={facets}
              filters={filters}
              onToggleType={(value) => toggleFacet('types', value)}
              onToggleYear={(value) => toggleFacet('years', value)}
              onToggleAdult={() => setFilters((prev) => ({ ...prev, adultOnly: !prev.adultOnly }))}
            />
          )}
          {/* 成人内容过滤只在「设置 → 首页与内容过滤」里统一开关，首页不再放行内开关 */}
        </section>

        {/* 搜索结果 */}
        {urlQuery && (
          <section aria-label="搜索结果" className="mb-10" ref={resultsRef}>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <h2 className="w-full text-sm text-muted sm:w-auto">
                “<span className="text-content">{urlQuery}</span>” 的搜索结果
                {isSearching ? (
                  <span className="text-faint">（搜索中…）</span>
                ) : (
                  searchQuery.data && (
                    <span className="text-faint">
                      {filtersActive
                        ? `（筛选出 ${filteredGroups.length} 部 · ${filteredSourceCount} 条 / 共 ${groups.length} 部 · ${visibleSourceCount} 条）`
                        : `（${groups.length} 部 · ${visibleSourceCount} 条）`}
                      {expandBusy ? ' · 正在搜索更多源…' : ''}
                      {!expandBusy && expandFailed ? ' · 更多源搜索失败' : ''}
                    </span>
                  )
                )}
              </h2>
              {filtersActive && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-accent hover:underline"
                  onClick={clearFilters}
                >
                  清除筛选
                </button>
              )}
            </div>

            {/* 过滤提示条：被隐藏的条数要说出来，否则用户只会看到「没找到」 */}
            {yellowFilter && filteredAdultCount > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-chip px-3 py-2 text-xs">
                <span className="text-muted">已按「成人内容过滤」隐藏 {filteredAdultCount} 条相关结果</span>
                <span className="text-faint">需要查看可在「设置 → 首页与内容过滤」中关闭</span>
              </div>
            )}

            {selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : isSearching || (expandBusy && groups.length === 0) ? (
              <ResultsSkeleton />
            ) : groups.length > 0 ? (
              filteredGroups.length > 0 ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                    {visibleGroups.map((group) => (
                      <AggregatedCard
                        key={group.key}
                        group={group}
                        sources={selectedSources}
                        onOpen={openDetail}
                        onPlay={playBest}
                      />
                    ))}
                  </div>
                  {/* 提示条贴着「加载更多」：翻页的用户就在这个位置，放在列表顶部等于看不见 */}
                  {orderChanged && (
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-lg bg-chip px-3 py-2 text-xs">
                      <span className="text-muted">结果已更新</span>
                      <button className="btn-ghost btn-sm" onClick={applyResort}>
                        按相关性排序
                      </button>
                    </div>
                  )}
                  {orderedGroups.length > visibleCount && (
                    <div className="flex justify-center mt-4">
                      <button className="btn-ghost btn-sm" onClick={loadMore}>
                        加载更多（还有 {orderedGroups.length - visibleCount} 部）
                      </button>
                    </div>
                  )}
                  {moreSourcesAction && (
                    <div className="mt-4 flex justify-center">
                      {moreSourcesAction}
                    </div>
                  )}
                </>
              ) : (
                <EmptyState
                  icon="search"
                  title="没有符合筛选条件的结果"
                  action={
                    <button className="btn-ghost btn-sm" onClick={clearFilters}>
                      清除筛选
                    </button>
                  }
                  className="!py-16"
                />
              )
            ) : (
              <EmptyState
                icon="search"
                title={expandFailed ? '更多源搜索失败，当前结果已保留' : '没有找到匹配的结果'}
                action={
                  moreSourcesAction ? (
                    <div className="flex flex-col items-center gap-2">{moreSourcesAction}</div>
                  ) : undefined
                }
                className="!py-16"
              />
            )}
          </section>
        )}

        {/* 首页推荐（有搜索时隐藏） */}
        {!urlQuery && (
          <RecommendSection
            onPick={(title) => {
              setInput(title);
              runSearch(title);
            }}
          />
        )}
      </main>

      {/* 页脚整块移除，只保留这一句底线声明 */}
      <p className="text-center text-[11px] text-faint/70 pb-6">我也是有底线的</p>

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        // 结构对齐真实结果卡（左侧缩略图 + 右侧文字块），避免占位与真实卡片形状不符
        <div key={i} className="card flex h-28 overflow-hidden">
          <div className="w-[105px] sm:w-[120px] shrink-0 bg-chip animate-pulse" />
          <div className="flex-1 p-2.5 space-y-2">
            <div className="h-4 w-3/4 rounded bg-chip animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-chip animate-pulse" />
            <div className="h-3 w-full rounded bg-chip animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 无点播源 / 未勾选点播源时的引导（替代旧版首屏静默空白） */
function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">{hasSources ? '尚未勾选点播源' : '还没有点播源'}</h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>到「设置 → 点播源」勾选后重新搜索。</>
        ) : (
          <>
            到「设置 → 添加 API」填入 Apple CMS 接口地址，如{' '}
            <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>。
          </>
        )}
      </p>
    </div>
  );
}

/**
 * 搜索结果标签筛选条：搜索框正下方，从当前结果自动生成。
 * 类型/年份可多选（同类目 OR、跨类目 AND），18 禁是可开关的单选过滤。
 */
function SearchFacetBar({
  facets,
  filters,
  onToggleType,
  onToggleYear,
  onToggleAdult,
}: {
  facets: SearchFacets;
  filters: SearchFilters;
  onToggleType: (value: string) => void;
  onToggleYear: (value: string) => void;
  onToggleAdult: () => void;
}) {
  const showTypes = facets.types.length > 1 || filters.types.length > 0;
  const showYears = facets.years.length > 1 || filters.years.length > 0;
  const showAdult = (facets.adult.adult > 0 && facets.adult.normal > 0) || filters.adultOnly;
  if (!showTypes && !showYears && !showAdult) return null;

  return (
    <div role="group" aria-label="筛选搜索结果" className="mt-3 w-full max-w-2xl space-y-1.5">
      {showTypes && (
        <FacetRow label="类型" options={facets.types} selected={filters.types} onToggle={onToggleType} />
      )}
      {showYears && (
        <FacetRow label="年份" options={facets.years} selected={filters.years} onToggle={onToggleYear} />
      )}
      {showAdult && (
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-faint">分级</span>
          <button
            type="button"
            aria-pressed={filters.adultOnly}
            onClick={onToggleAdult}
            className={cn(
              'chip border',
              filters.adultOnly
                ? 'border-accent bg-accent text-on-accent'
                : 'border-transparent bg-chip text-muted hover:bg-hover hover:text-content'
            )}
          >
            18禁
            <span className={cn('tabular-nums', filters.adultOnly ? 'opacity-80' : 'text-faint')}>
              {facets.adult.adult}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 单行标签组：窄屏横向滚动（不换行挤压结果），sm 以上自动换行 */
function FacetRow({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 sm:items-start">
      <span className="w-8 shrink-0 text-[11px] text-faint sm:pt-1">{label}</span>
      <div className="no-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible">
        {options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(option.value)}
              className={cn(
                'chip shrink-0 border',
                active
                  ? 'border-accent bg-accent text-on-accent'
                  : 'border-transparent bg-chip text-muted hover:bg-hover hover:text-content'
              )}
            >
              {option.value}
              <span className={cn('tabular-nums', active ? 'opacity-80' : 'text-faint')}>{option.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
