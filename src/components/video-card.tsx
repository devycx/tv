'use client';

import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { SearchResultItem, SourceConfig } from '@/lib/types';
import { readQuality, useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import { compactRemarks, episodeCountOf } from '@/lib/remarks';
import type { AggregatedGroup } from '@/lib/search-groups';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { QualityBadge } from './quality-badge';
import { useQualityProbe } from './use-quality-probe';
import { useInView } from './use-in-view';

/**
 * 聚合影片卡片：
 * - 点击封面图 → 立即播放（播放页会挑画质最好的源、剧集默认最新一集）；
 * - 点击文字区 → 打开详情（看简介 / 选集）；
 * - 多源：显示「N 个来源」徽章，展开后可选择具体源。
 */
export function AggregatedCard({
  group,
  onOpen,
  onPlay,
  sources,
}: {
  group: AggregatedGroup;
  onOpen: (item: SearchResultItem) => void;
  /** 点封面直达播放：由页面负责拼播放页 URL */
  onPlay: (item: SearchResultItem) => void;
  /** 完整源配置：探测画质需要 source.url / source.detail，搜索结果里只带 sourceUrl */
  sources?: SourceConfig[];
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showImg = !!group.pic && !imgFailed;

  const multi = group.items.length > 1;
  const adult = useMemo(() => group.items.some((i) => i.isAdult), [group.items]);

  const { qualities, probing, progress, prime, probe, probeQueued, retry } = useQualityProbe(sources);

  // 收起态就要有结论：先读缓存（展开时才真正探测）。
  // 依赖 group.key 而不是 items 数组——搜索页每次重渲染都会重建分组对象，
  // 用数组做依赖会让这个 effect 每帧触发，进而 setState 死循环。
  useEffect(() => {
    prime(group.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.key]);

  // 进入视口 500ms 后整组交给全局队列探测：多源卡片在收起态也要有「最高画质」结论，
  // 否则首屏十几张「N 个来源」全是未知，既不能排序也没法判断该点哪个。
  // 队列自身限并发（默认 4、每批 12），不会因为一屏卡片同时入队就打出请求风暴。
  const { ref: inViewRef, inView } = useInView<HTMLDivElement>();
  const itemsSignal = `${group.key}|${group.items.length}`;
  useEffect(() => {
    if (inView) probeQueued(group.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, itemsSignal, probeQueued]);

  const singleItem = multi ? undefined : group.items[0];
  const singleKey = singleItem ? qualityKey(singleItem.sourceKey, singleItem.vodId) : undefined;

  // 展开面板按「画质降序 → 集数降序」排：同一部剧里画质最高、集数最全的源排第一，
  // 用户不必自己横向比较三行灰字。都没探到 / 同分时保持原有源顺序。
  const heightOf = (item: SearchResultItem) =>
    readQuality(item.sourceKey, item.vodId)?.height ?? qualities[qualityKey(item.sourceKey, item.vodId)]?.height ?? 0;
  const sortedItems = useMemo(() => {
    return group.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const byHeight = heightOf(b.item) - heightOf(a.item);
        if (byHeight !== 0) return byHeight;
        // 集数只做同画质内的次级排序：源站备注里写着「全34集」/「更新至12集」，
        // 12 集的进度不代表这部只有 12 集，所以只用来区分「哪个源更全」
        const byEpisodes = episodeCountOf(b.item.remarks) - episodeCountOf(a.item.remarks);
        if (byEpisodes !== 0) return byEpisodes;
        return a.index - b.index;
      })
      .map((entry) => entry.item);
    // qualities 变化时重排：探测结果逐条回来，先到的更好画质要能立刻升到第一行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.items, qualities]);
  const bestHeight = sortedItems.reduce((max, item) => Math.max(max, heightOf(item)), 0);
  // 封面直达播放用哪个源：排序后的第一行（画质最高；都没结论时沿用源顺序）。
  // 播放页随时可「切换资源」，所以不需要让用户先选源再播。
  const bestItem = sortedItems[0] ?? group.items[0];
  const playFromCover = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    onPlay(bestItem);
  };
  // 并列最高时只强调排在第一的那一行：三个源里框两个等于没有推荐
  const firstBest = sortedItems.find((item) => bestHeight > 0 && heightOf(item) === bestHeight);
  const bestKey = firstBest ? qualityKey(firstBest.sourceKey, firstBest.vodId) : undefined;
  // 各源集数一致时（常见：同剧多源同步更新）只在表头说一次，逐行不再重复
  const remarksList = sortedItems.map((item) => compactRemarks(item.remarks));
  const sharedRemarks =
    remarksList.length > 0 && remarksList.every((label) => label && label === remarksList[0])
      ? remarksList[0]
      : undefined;

  const activate = () => {
    if (multi) {
      const next = !expanded;
      setExpanded(next);
      if (next) probe(group.items);
    } else {
      onOpen(group.items[0]);
    }
  };

  return (
    <div
      ref={inViewRef}
      className={cn('card', !multi && 'hover:scale-[1.02] hover:shadow-md', multi && expanded && 'ring-1 ring-accent/40')}
    >
      {/* 不用 h-full：展开面板需要撑高卡片，等高裁切会让面板不可见 */}
      <div
        className="flex h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        role="button"
        tabIndex={0}
        aria-expanded={multi ? expanded : undefined}
        onClick={activate}
        onKeyDown={(e) => {
          // 内层按钮/来源行自己处理键盘与点击，避免冒泡造成双触发
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
      >
        {showImg ? (
          <div
            className="relative flex-shrink-0 w-[105px] sm:w-[120px] aspect-[2/3] bg-chip cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label={`直接播放 ${group.name}`}
            title="直接播放"
            onClick={playFromCover}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              playFromCover(e);
            }}
          >
            <SmartImage
              url={group.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={group.name}
              className="absolute inset-0 h-full w-full object-cover"
              onExhausted={() => setImgFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent" />
            {multi && (
              <span className="absolute top-1.5 left-1.5 tag bg-black/70 text-accent font-medium">
                {group.items.length} 源
              </span>
            )}
          </div>
        ) : (
          <div
            className="relative flex-shrink-0 w-[105px] sm:w-[120px] aspect-[2/3] bg-chip flex items-center justify-center cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label={`直接播放 ${group.name}`}
            title="直接播放"
            onClick={playFromCover}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              playFromCover(e);
            }}
          >
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
            {multi && (
              <span className="absolute top-1.5 left-1.5 tag bg-black/70 text-accent font-medium">
                {group.items.length} 源
              </span>
            )}
          </div>
        )}

        <div className="p-2.5 flex flex-col flex-grow min-w-0">
          <div className="flex-grow">
            <h3 className="font-semibold text-sm text-content mb-1.5 line-clamp-2" title={group.name}>
              {group.name}
            </h3>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {group.typeName && <span className="tag bg-accent/15 text-accent">{group.typeName}</span>}
              {group.year && <span className="tag bg-purple-500/15 text-purple-600 dark:text-purple-300">{group.year}</span>}
              {adult && <span className="tag bg-pink-500/15 text-pink-600 dark:text-pink-400">18🈲</span>}
              {/* 单源卡片没有展开列表，画质只能在这里露出；失败态可点重试 */}
              {singleKey && (
                <QualityBadge
                  entry={qualities[singleKey]}
                  loading={probing[singleKey]}
                  onRetry={singleItem ? () => retry([singleItem]) : undefined}
                />
              )}
            </div>
            <p className="text-xs text-muted line-clamp-2 mb-2">{group.remarks || '暂无介绍'}</p>
          </div>
          <div className="flex items-center justify-between gap-1.5 mt-auto pt-1.5 border-t border-line">
            <span className="tag bg-chip text-muted truncate max-w-[80%]">
              {multi ? `${group.items.length} 个来源` : group.items[0].sourceName}
            </span>
            {multi && (
              <span className="flex items-center gap-1 shrink-0">
                {/* 收起态先给结论：最高画质比「N 个来源」更影响要不要点开 */}
                {progress.best && (
                  <span
                    className="tag bg-accent/15 text-accent font-medium"
                    title={
                      progress.known < progress.total
                        ? `已探到 / 实测的最高画质（${progress.known}/${progress.total} 个来源已有结论）`
                        : '已探到 / 实测的最高画质'
                    }
                  >
                    {progress.best}
                  </span>
                )}
                <svg
                  className={cn('w-4 h-4 text-faint transition-transform', expanded && 'rotate-180')}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            )}
          </div>
        </div>
      </div>

      {multi && expanded && (
        <div className="border-t border-line p-2.5 animate-fade-in">
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <p className="text-[10px] text-faint">
              选择来源
              {sharedRemarks ? ` · 均 ${sharedRemarks}` : ''}
            </p>
            {progress.total > 0 &&
              (progress.done < progress.total ? (
                <p className="text-[10px] text-faint tabular-nums">
                  探测中 {progress.done}/{progress.total}
                </p>
              ) : (
                // 探完后「3/3」已经没有信息量，换成用户真正要的结论
                <p className="text-[10px] text-accent tabular-nums">
                  {progress.best ? `最高 ${progress.best}` : '未能探到画质'}
                  {progress.failed > 0 ? ` · ${progress.failed} 源未探到` : ''}
                </p>
              ))}
          </div>
          {/*
            单列全宽行：两列在卡片实际宽度（约 330px）下每列只剩 148px，
            源名必截断，且源数为奇数时必然留半行空。一行内「源名 / 画质 / 集数 / 播放」
            四段排开，信息密度更高也更容易纵向扫读。
          */}
          <div className="flex flex-col gap-1.5">
            {sortedItems.map((item) => {
              const itemKey = qualityKey(item.sourceKey, item.vodId);
              const label = compactRemarks(item.remarks);
              const isBest = itemKey === bestKey;
              return (
                <div
                  key={`${item.sourceKey}_${item.vodId}`}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'group flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2',
                    'text-xs transition-all cursor-pointer',
                    'bg-chip hover:border-accent hover:bg-accent/10',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    isBest ? 'border-accent/50' : 'border-line',
                    item.isAdult && 'border-pink-500/30'
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(item);
                  }}
                  onKeyDown={(e) => {
                    // 不拦冒泡会连带触发整卡的 activate（外层 div 也在监听 Enter/Space）
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    onOpen(item);
                  }}
                  aria-label={`使用 ${item.sourceName} 播放${label && !sharedRemarks ? `，${label}` : ''}`}
                >
                  <span className="font-medium text-content truncate flex-1 min-w-0">{item.sourceName}</span>
                  {/* 最高画质来源给明确文字标记：边框高亮在窄屏上不够显眼 */}
                  {isBest && (
                    <span className="tag bg-accent/15 text-accent shrink-0 font-medium">最高</span>
                  )}
                  <QualityBadge
                    entry={qualities[itemKey]}
                    loading={probing[itemKey]}
                    onRetry={() => retry([item])}
                    // 定宽 + 等宽数字：三行的 360P / 540P / 1080P 左缘对齐，不随字符数抖动
                    className="min-w-[3.25rem] justify-center tabular-nums"
                  />
                  {/* 集数一致时已提到表头，逐行不再重复 */}
                  {!sharedRemarks && label && (
                    <span className="text-faint shrink-0 tabular-nums">{label}</span>
                  )}
                  <svg
                    className="w-3.5 h-3.5 text-accent shrink-0 transition-transform group-hover:translate-x-0.5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** 豆瓣推荐卡片（无来源徽章，点击直接搜索） */
export function DoubanCard({ item, onClick }: { item: { title: string; cover: string; rating?: string }; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [item.cover]);

  return (
    <div
      className="card cursor-pointer hover:scale-[1.03] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // 阻止空格触发页面滚动（AggregatedCard 已是此写法，此处对齐）
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative aspect-[2/3] bg-chip">
        {item.cover && !imgFailed ? (
          <SmartImage
            url={item.cover}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.title}
            className="w-full h-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-chip">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
          </div>
        )}
        {item.rating && (
          <span className={cn('absolute top-1.5 right-1.5 tag bg-black/70 text-rating font-medium')}>
            ★ {item.rating}
          </span>
        )}
      </div>
      <div className="p-2">
        <div className="text-xs font-medium text-content truncate" title={item.title}>
          {item.title}
        </div>
      </div>
    </div>
  );
}
