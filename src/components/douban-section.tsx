'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem, DoubanResponse } from '@/lib/types';
import { mergeRecommendationPages, nextRecommendationOffset, RECOMMEND_PAGE_SIZE } from '@/lib/recommendation-pages';
import generatedBootstrap from '@/lib/bootstrap.generated.json';
import type { BootstrapConfig } from '@/lib/bootstrap';
import { DoubanCard } from './video-card';

const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'];
const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 构建期内联的首屏种子：首屏 0 请求出真实封面，过期后由 React Query 后台刷新 */
const bootstrap = generatedBootstrap as BootstrapConfig;
const SEED_STALE_MS = 90 * 1000;

/** 推荐数据缓存时间：预热后 5 分钟内点击标签直接命中，避免重复请求 */
const RECOMMEND_STALE_MS = 5 * 60_000;

/**
 * 在浏览器空闲时执行一次预热任务：首页推荐标签点开才请求，
 * 提前把数据拉进 React Query 缓存，点击时不再等网络。
 * 不支持 requestIdleCallback 的环境（Safari 旧版等）退化为 300ms 定时。
 */
function runWhenIdle(task: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task, { timeout: 1500 });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, 300);
  return () => window.clearTimeout(id);
}

/** 首页推荐区：数据源由设置决定（豆瓣热门 / Bangumi 新番放送 / 影视热榜），二选一展示 */
export function RecommendSection({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const recommendSource = useAppStore((s) => s.recommendSource);

  if (!doubanEnabled) return null;
  if (recommendSource === 'bangumi') return <BangumiView onPick={onPick} />;
  if (recommendSource === 'hot-list') return <HotListView onPick={onPick} />;
  return <DoubanView onPick={onPick} />;
}

/**
 * 豆瓣推荐：影视切换 + 标签筛选。
 * 首批 50 条，滚动接近列表末尾时获取下一批真实数据；分类之间隔离缓存。
 * 空页/完全重复页停止；下一页失败时保留现有卡片，用户可以重试。
 *
 * 默认展开「电影 / 热门」；再次点击当前标签可收起。
 */
function DoubanView({ onPick }: { onPick: (title: string) => void }) {
  const [type, setType] = useState<'movie' | 'tv'>('movie');
  const [tag, setTag] = useState<string | null>(MOVIE_TAGS[0]);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const seeded = tag !== null ? bootstrap.recommendSeed?.[`${type}:${tag}`] ?? null : null;
  const query = useInfiniteQuery({
    queryKey: ['douban-scroll', type, tag, RECOMMEND_PAGE_SIZE],
    enabled: tag !== null,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => {
      if (tag === null) throw new Error('未选择推荐标签');
      return api.douban(type, tag, pageParam, RECOMMEND_PAGE_SIZE, signal);
    },
    getNextPageParam: (last, pages, offset) => nextRecommendationOffset(last, pages, offset),
    // 切换标签/影视时保留上一份数据，不再闪骨架屏
    placeholderData: (prev) => prev,
    // 有种子时首帧直接出卡片；超时后后台静默刷新，用户无感
    initialData: seeded?.length ? { pages: [{ items: seeded }], pageParams: [0] } : undefined,
    initialDataUpdatedAt: seeded?.length ? Date.parse(bootstrap.recommendSeedAt) || undefined : undefined,
    staleTime: seeded?.length ? SEED_STALE_MS : RECOMMEND_STALE_MS,
    retry: false,
  });

  const tags = type === 'movie' ? MOVIE_TAGS : TV_TAGS;

  /** 预热某个标签的第一页（与点击时 useInfiniteQuery 用同一个 queryKey / queryFn） */
  const prefetchTag = useCallback(
    (t: string) => {
      void queryClient.prefetchInfiniteQuery({
        queryKey: ['douban-scroll', type, t, RECOMMEND_PAGE_SIZE],
        queryFn: ({ pageParam, signal }) =>
          api.douban(type, t, pageParam as number, RECOMMEND_PAGE_SIZE, signal),
        initialPageParam: 0,
        getNextPageParam: (last: DoubanResponse, pages: DoubanResponse[], offset: number) =>
          nextRecommendationOffset(last, pages, offset),
        staleTime: RECOMMEND_STALE_MS,
      });
    },
    [queryClient, type]
  );

  // 首页推荐区挂载后预热当前类型的标签页；已有种子的热门标签跳过，避免覆盖首屏数据
  useEffect(
    () =>
      runWhenIdle(() =>
        tags.filter((t) => !bootstrap.recommendSeed?.[`${type}:${t}`]?.length).forEach(prefetchTag)
      ),
    [tags, prefetchTag, type]
  );

  const items = useMemo(
    () => (tag === null ? [] : mergeRecommendationPages(query.data?.pages ?? [])),
    [tag, query.data]
  );
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetching || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return;
    // 提前一屏多触发下一页：封面是懒加载的，600px 余量在快速滚动时来不及解码，
    // 会先露出大片灰底/胶片兜底。1600px 让封面有足够时间进入浏览器懒加载距离。
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage({ cancelRefetch: false });
    }, { rootMargin: '1600px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, type, tag]);

  const switchType = (t: 'movie' | 'tv') => {
    if (t === type) return;
    setType(t);
    // 换类型后默认展开新类型的「热门」：旧标签在新类型下可能不存在
    setTag((t === 'movie' ? MOVIE_TAGS : TV_TAGS)[0]);
  };

  return (
    <section aria-label="影视推荐">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex bg-chip rounded-lg p-0.5">
            <TypeButton active={type === 'movie'} onClick={() => switchType('movie')}>
              电影
            </TypeButton>
            <TypeButton active={type === 'tv'} onClick={() => switchType('tv')}>
              剧集
            </TypeButton>
          </div>
        </div>
      </div>

      <div className={cn('flex flex-wrap gap-1.5', tag === null ? 'mb-0' : 'mb-4')}>
        {tags.map((t) => (
          <button
            key={t}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs transition-colors',
              t === tag ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setTag((prev) => (prev === t ? null : t))}
            onPointerEnter={() => prefetchTag(t)}
            onFocus={() => prefetchTag(t)}
            aria-pressed={t === tag}
          >
            {t}
          </button>
        ))}
      </div>

      {tag === null ? null : query.isError && items.length === 0 ? (
        <div className="text-center text-sm text-faint py-8">
          <p>推荐内容加载失败</p>
          <button className="btn-ghost btn-sm mt-2" onClick={() => void query.refetch()}>重试</button>
        </div>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">暂无推荐</p>
      ) : (
        <div data-recommendation-grid className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {items.map((item, i) => (
            <DoubanCard key={item.id} item={item} priority={i < 16} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
      {tag !== null && items.length > 0 && (
        <div ref={loadMoreRef} data-recommendation-more className="text-center text-sm text-muted py-6">
          {query.isFetchingNextPage ? (
            <p role="status">加载中…</p>
          ) : query.isFetchNextPageError ? (
            <div role="status">
              <p>加载更多失败</p>
              <button className="btn-ghost btn-sm mt-2" onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>重试</button>
            </div>
          ) : query.hasNextPage ? (
            <button className="btn-ghost btn-sm" onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>加载更多</button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * Bangumi 每日放送：星期筛选，一次拉全量无分页。
 * 默认不选中星期（首页推荐区收起），点星期/全部才展示封面，再次点击当前项收起。
 */
function BangumiView({ onPick }: { onPick: (title: string) => void }) {
  const [weekday, setWeekday] = useState<number | 'all' | null>(null);
  const queryClient = useQueryClient();

  const prefetchCalendar = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey: ['bangumi-calendar'],
      queryFn: ({ signal }) => api.bangumiCalendar(signal),
      staleTime: RECOMMEND_STALE_MS,
    });
  }, [queryClient]);

  // 星期共用同一份 calendar 数据：挂载后预热，点任意星期立即出列表
  useEffect(() => runWhenIdle(prefetchCalendar), [prefetchCalendar]);

  const query = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
    enabled: weekday !== null,
    staleTime: RECOMMEND_STALE_MS,
  });

  let items: DoubanItem[] = [];
  if (query.data && weekday !== null) {
    items = weekday === 'all'
      ? query.data.days.flatMap((d) => d.items)
      : (query.data.days.find((d) => d.weekday === weekday)?.items ?? []);
  }

  const toggleWeekday = (value: number | 'all') => setWeekday((prev) => (prev === value ? null : value));

  return (
    <section aria-label="新番放送推荐">
      <div className={cn('flex flex-wrap gap-1.5', weekday === null ? 'mb-0' : 'mb-4')}>
        <ChipButton active={weekday === 'all'} onClick={() => toggleWeekday('all')} onPrefetch={prefetchCalendar}>
          全部
        </ChipButton>
        {WEEKDAYS.map((name, i) => (
          <ChipButton
            key={name}
            active={weekday === i + 1}
            onClick={() => toggleWeekday(i + 1)}
            onPrefetch={prefetchCalendar}
          >
            {name}
          </ChipButton>
        ))}
      </div>

      {weekday === null ? null : query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_chinese', label: '国产剧周榜' },
  { id: 'douban_tv_global', label: '海外剧周榜' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'baidu_teleplay', label: '百度热播剧' },
];

/**
 * 影视热榜（60s API）：豆瓣五个周榜 + 百度热播剧，chips 切换。
 * 默认不展开任何榜单（首页只显示标签）：点标签才拉数据/展示封面，再次点击当前标签收起。
 */
function HotListView({ onPick }: { onPick: (title: string) => void }) {
  const [listId, setListId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const prefetchList = useCallback(
    (id: string) => {
      void queryClient.prefetchQuery({
        queryKey: ['hot-list', id],
        queryFn: ({ signal }) => api.hotList(id, signal),
        staleTime: RECOMMEND_STALE_MS,
      });
    },
    [queryClient]
  );

  // 六个榜单在首页空闲时全部预热：点标签直接出封面，不再先看骨架屏
  useEffect(() => runWhenIdle(() => HOT_LISTS.forEach((l) => prefetchList(l.id))), [prefetchList]);

  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => {
      if (listId === null) throw new Error('未选择榜单');
      return api.hotList(listId, signal);
    },
    enabled: listId !== null,
    staleTime: RECOMMEND_STALE_MS,
  });

  const items = listId === null ? [] : (query.data?.items ?? []);

  return (
    <section aria-label="影视榜单推荐">
      <div className={cn('flex flex-wrap gap-1.5', listId === null ? 'mb-0' : 'mb-4')}>
        {HOT_LISTS.map((l) => (
          <ChipButton
            key={l.id}
            active={listId === l.id}
            onClick={() => setListId((prev) => (prev === l.id ? null : l.id))}
            onPrefetch={() => prefetchList(l.id)}
          >
            {l.label}
          </ChipButton>
        ))}
      </div>

      {listId === null ? null : query.isError ? (
        <p className="text-center text-sm text-faint py-8">推荐内容加载失败</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  children,
  onPrefetch,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** 悬停/聚焦时提前预热该标签的数据（触摸端由 idle 预热兜底） */
  onPrefetch?: () => void;
}) {
  return (
    <button
      className={cn(
        'px-2.5 py-1 rounded-full text-xs transition-colors',
        active ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
    >
      {children}
    </button>
  );
}

function TypeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn('px-3.5 py-1.5 rounded-md text-sm transition-colors', active ? 'bg-accent text-on-accent' : 'text-muted hover:text-content')}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
