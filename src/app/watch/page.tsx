'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import { SkipMarkPanel } from '@/components/skip-mark-panel';
import { useDocumentTitle } from '@/components/use-document-title';
import { resolveArtwork } from '@/lib/media-session';
import { brandTitle } from '@/lib/site';
import { skipMarkKey, validateSegment, type SkipSegment } from '@/lib/skip-marks';
import type { PlayerSkipApi } from '@/components/player-shell';
import { useToast } from '@/components/toast';
import { enqueueDownload, enqueueDownloads } from '@/components/download-manager';
import { buildEpisodeDownloadPayloads } from '@/lib/download-batch';
import { Icon } from '@/components/icon';
import { useAuth } from '@/components/auth';
import { Header } from '@/components/header';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import {
  clearProgress,
  getLatestProgress,
  patchHistoryMeta,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  db,
} from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * 播放页（唯一入口，替代旧版 watch.html → player.html 跳转链）。
 * 状态全部由 URL 驱动：/watch?source=xx&id=..&index=..&title=..
 * 集数列表由服务端详情接口获取；进度与历史走 IndexedDB。
 */
const UNKNOWN_TITLE = '未知视频';

export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const { verified } = useAuth();
  const { toast } = useToast();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexRaw = searchParams.get('index');
  /** 点封面直达播放：集数交给播放页决定（有进度续播，否则默认第一集） */
  const wantsLatest = indexRaw === 'last';
  const indexParam = parseInt(indexRaw || '0', 10) || 0;

  const [reversed, setReversed] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [skipPanelOpen, setSkipPanelOpen] = useState(false);
  // 播放器对外暴露的精确时间读取接口（「记录当前」用），随播放器卸载置空
  const playerApiRef = useRef<PlayerSkipApi | null>(null);
  // 播放框：小屏「跳过标记」抽屉要按它的底边算剩余高度，避免压住画面
  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const [sheetMaxHeight, setSheetMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!skipPanelOpen) return;
    const measure = () => {
      // 桌面端抽屉贴右侧、整屏高，不受播放器位置影响
      if (window.matchMedia('(min-width: 1024px)').matches) {
        setSheetMaxHeight(undefined);
        return;
      }
      const box = playerFrameRef.current?.getBoundingClientRect();
      if (!box) {
        setSheetMaxHeight(undefined);
        return;
      }
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const room = viewport - box.bottom - 12;
      // 不超过视口 60%；矮窗下最多压到 160px，再小就没法用了
      setSheetMaxHeight(Math.round(Math.max(160, Math.min(viewport * 0.6, room))));
    };
    measure();
    // 只在打开与尺寸变化时测：跟着滚动实时改高度会让抽屉边滚边长，很晃
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [skipPanelOpen]);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  // 详情查询：无 id（纯直连链接分享）时跳过
  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const episodes = useMemo(() => detailQuery.data?.episodes ?? [], [detailQuery.data]);
  const videoTitle = titleParam || detailQuery.data?.videoInfo?.title || UNKNOWN_TITLE;

  // 当前播放地址：优先取剧集列表中的当前集，其次直连 URL 参数
  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  // 跳过片段按剧名记忆：换集不变，换源到同名资源也能命中。
  // 标题缺失（直连链接）时退回 source:vodId，至少保证本源本片可用。
  const skipMarkFallback = `${sourceKey}:${vodId || currentUrl}`;
  const markKey = useMemo(
    () => skipMarkKey(videoTitle, skipMarkFallback),
    [videoTitle, skipMarkFallback]
  );
  const skipMark = store.skipMarks[markKey];
  const markedCount = skipMark?.segments.length ?? 0;

  // 中段两步态的起点：页面层持有，面板按钮与 Shift+S/E 共用同一份状态
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  // 换集清空中段两步态：起点属于上一集，不能和新集的位置拼成区间
  useEffect(() => setPendingStart(null), [sourceKey, vodId, currentIndex]);

  const goEpisode = useCallback(
    (index: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  // `index=last` 的落地：优先回到「最近看过的那一集」，没有进度就默认第一集。
  // 解析完立刻把 URL 换成具体集数（刷新/分享都稳定），并且只跑一次，避免来回重定向。
  const [latestResolved, setLatestResolved] = useState(false);
  useEffect(() => {
    if (!wantsLatest || latestResolved || episodes.length === 0) return;
    let cancelled = false;
    (async () => {
      const saved = vodId ? await getLatestProgress(sourceKey, vodId) : undefined;
      if (cancelled) return;
      setLatestResolved(true);
      // 源站集数可能变少（下架/重编），越界的进度索引要夹回列表范围
      const target = saved ? Math.min(saved.episodeIndex, episodes.length - 1) : 0;
      goEpisode(target);
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsLatest, latestResolved, episodes.length, goEpisode, sourceKey, vodId]);

  // 解析「续播 / 默认第一集」期间先别渲染播放器：否则会先起播错误的一集、随后又被换掉
  const resolvingLatest = wantsLatest && !latestResolved && episodes.length > 0;

  // 进度恢复优先级：URL position 参数 > IndexedDB 记录
  const getRestorePosition = useCallback(async () => {
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    return entry?.position ?? 0;
  }, [searchParams, sourceKey, vodId, currentIndex]);

  // 写入观看历史（进入页面即记录，进度后续增量更新）
  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: detailQuery.data?.videoInfo?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl]);

  // 详情/剧集异步返回后补写历史元数据：封面与总集数可能晚于历史写入到达。
  // 这里必须用独立 effect（只带元数据依赖）：若把 detailQuery.data / episodes 塞进上面
  // upsertHistory 的依赖，详情每次刷新都会重置 2s 定时器，且 upsert 的 playbackPosition=0
  // 会把已恢复的进度打回。patchHistoryMeta 只补空封面/变化的总集数，不碰进度与时间戳。
  const cover = detailQuery.data?.videoInfo?.cover;
  const totalEpisodes = episodes.length;
  const historyVodId = vodId || currentUrl;

  useEffect(() => {
    if (!verified || !sourceKey || !historyVodId || (!cover && totalEpisodes === 0)) return;
    patchHistoryMeta(sourceKey, historyVodId, { pic: cover, totalEpisodes }).catch(() => {});
  }, [verified, sourceKey, historyVodId, cover, totalEpisodes]);

  // —— 系统媒体会话（安卓通知栏/锁屏）与窗口标题 ——
  // 只看「多集」：单集影片（含电影）不写集数，避免出现「第 1 集」这种噪音。
  const episodeLabel = totalEpisodes > 1 ? `第 ${currentIndex + 1} 集` : undefined;
  // 封面与卡片/详情页共用候选链：豆瓣图先走公共镜像（原站对空 Referer 回 418），并升到 /m/
  const mediaArtwork = useMemo(
    () => resolveArtwork(cover, store.imageProxyMode, store.customImageProxy),
    [cover, store.imageProxyMode, store.customImageProxy]
  );
  // 详情回来之前 title 还是「未知视频」：别把占位文案先写进标签页/通知栏
  useDocumentTitle(
    videoTitle === UNKNOWN_TITLE
      ? undefined
      : brandTitle(episodeLabel ? `${videoTitle} ${episodeLabel}` : videoTitle)
  );

  // 播放中与暂停时的进度落盘逻辑一致，共用同一回调
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (vodId) {
        saveProgress(sourceKey, vodId, currentIndex, position, duration).catch(() => {});
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration).catch(() => {});
      }
    },
    [sourceKey, vodId, currentIndex, currentUrl]
  );

  // 下载本集：入口在播放器控制条里（挂 playerApi 之前就要能用，所以放在页面层）
  const handleDownload = useCallback(() => {
    if (!currentUrl) return;
    enqueueDownload({
      url: currentUrl,
      // 多集才带集数后缀；单集影片（含电影）文件名就是纯标题
      title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
      format: 'MP4',
    });
    // 「已加入下载队列」由 DownloadManager 在真正入队后提示：
    // 这里先提示的话，用户随后取消保存位置会出现「已加入→已取消」的矛盾
  }, [currentUrl, videoTitle, episodes.length, currentIndex]);

  // 下载全部：剧集侧栏入口；按源站原始顺序入队，不受「倒序排列」影响
  const handleDownloadAll = useCallback(() => {
    if (episodes.length === 0) return;
    enqueueDownloads(buildEpisodeDownloadPayloads(videoTitle, episodes, 'MP4'));
  }, [episodes, videoTitle]);

  // 自动连播的 800ms 延迟切集要在卸载时取消，避免离开页面后跳转
  const autoNextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
  }, []);

  const handleEnded = useCallback(() => {
    if (vodId) clearProgress(sourceKey, vodId, currentIndex).catch(() => {});
    if (store.autoplayNext && currentIndex < episodes.length - 1) {
      autoNextTimer.current = setTimeout(() => goEpisode(currentIndex + 1), 800);
    }
  }, [store.autoplayNext, currentIndex, episodes.length, goEpisode, sourceKey, vodId]);

  // 快捷键（Shift+I/O/S/E）记录片段：校验后写入
  const handleRecordSegment = useCallback(
    (segment: SkipSegment) => {
      const duration = playerApiRef.current?.getDuration() ?? 0;
      const existing = useAppStore.getState().skipMarks[markKey]?.segments ?? [];
      const error = validateSegment(segment, duration, existing);
      if (error) {
        toast(error, 'error');
        return;
      }
      useAppStore.getState().setSkipMark(markKey, [...existing, segment]);
      const label =
        segment.type === 'opening' ? '片头结束' : segment.type === 'ending' ? '片尾开始' : '中段片段';
      // 中段命中时的表现取决于全局「自动跳过片段」，记完就说清楚，避免"标了却没反应"
      const hint =
        segment.type === 'middle'
          ? useAppStore.getState().autoSkipSegments
            ? '，命中时将自动跳过'
            : '，命中时显示跳过按钮'
          : '';
      toast(`已记录${label}${hint}`, 'success');
    },
    [markKey, toast]
  );

  // Alt+←/→ 集数切换快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        goEpisode(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < episodes.length - 1) {
        e.preventDefault();
        goEpisode(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [currentIndex, episodes.length, goEpisode]);

  const orderedEpisodes = reversed ? [...episodes].map((_, i) => episodes.length - 1 - i) : episodes.map((_, i) => i);

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-faint text-sm">等待访问验证...</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-content font-medium mb-2">点播源不存在</h1>
          <p className="text-sm text-muted mb-4">
            点播源「{sourceKey}」不存在或已被删除，请到设置中重新添加。
          </p>
          <Link href="/" className="btn-primary">返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* 与全站（首页搜索结果态）同一个顶栏：只保留返回 + 导航，
          标题挪到播放器上方——手机窄屏不再把标题、下载、切源全挤进一行 */}
      <Header leading={<BackButton />} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          <div>
            {/* 视频名称：导航栏下方、播放器上方，单独成块（不再塞进顶栏） */}
            <div className="mb-2.5">
              <h1 className="text-base sm:text-lg font-semibold text-content truncate" title={videoTitle}>
                {videoTitle}
              </h1>
              <p className="text-xs text-faint truncate">
                {source.name}
                {episodes.length > 0 && ` · 第 ${currentIndex + 1}/${episodes.length} 集`}
              </p>
            </div>
            <div ref={playerFrameRef} className="aspect-video bg-black rounded-lg overflow-hidden">
              {currentUrl && !resolvingLatest ? (
                <PlayerShell
                  url={currentUrl}
                  title={videoTitle}
                  artwork={mediaArtwork}
                  episodeLabel={episodeLabel}
                  adFilter={store.adFilter}
                  autoplayNext={store.autoplayNext}
                  skipMark={skipMark}
                  autoSkipSegments={store.autoSkipSegments}
                  volumeBoost={store.volumeBoost}
                  miniProgressBar={store.miniProgressBar}
                  pendingStart={pendingStart}
                  onPendingStart={setPendingStart}
                  onPlayerApi={(api) => { playerApiRef.current = api; }}
                  onRecordSegment={handleRecordSegment}
                  episodeKey={`${sourceKey}:${vodId}:${currentIndex}`}
                  nextUrl={currentIndex + 1 < episodes.length ? episodes[currentIndex + 1] : undefined}
                  nextEpisodeKey={currentIndex + 1 < episodes.length ? `${sourceKey}:${vodId}:${currentIndex + 1}` : undefined}
                  getRestorePosition={getRestorePosition}
                  onTimeUpdate={handleProgress}
                  onPause={handleProgress}
                  onEnded={handleEnded}
                  onDownload={handleDownload}
                  onAutoplayChange={(next) => store.updateSettings({ autoplayNext: next })}
                  hasPrevEpisode={currentIndex > 0}
                  hasNextEpisode={episodes.length > 0 && currentIndex < episodes.length - 1}
                  onPrevEpisode={() => goEpisode(currentIndex - 1)}
                  onNextEpisode={() => goEpisode(currentIndex + 1)}
                  onQuality={(height) => {
                    // 播放实测是最权威的画质来源，回写后搜索列表里该「源 + 影片」直接显示
                    if (!sourceKey || !vodId) return;
                    useAppStore.getState().setQuality({
                      [qualityKey(sourceKey, vodId)]: { height, from: 'play', timestamp: Date.now() },
                    });
                  }}
                  // 播放中源故障（重试耗尽/直连硬失败）：自动弹出换源面板，别只留一条 hint
                  onRequestSwitchSource={() => setSwitchOpen(true)}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {resolvingLatest || detailQuery.isLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailQuery.isError ? '视频加载失败，请尝试其他资源' : '无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 操作栏 */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                className="btn-ghost btn-sm"
                disabled={currentIndex <= 0}
                onClick={() => goEpisode(currentIndex - 1)}
              >
                上一集
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={episodes.length === 0 || currentIndex >= episodes.length - 1}
                onClick={() => goEpisode(currentIndex + 1)}
              >
                下一集
              </button>
              <button
                className={cn('btn-ghost btn-sm', skipPanelOpen && 'bg-chip text-content')}
                aria-expanded={skipPanelOpen}
                aria-haspopup="dialog"
                onClick={() => setSkipPanelOpen((v) => !v)}
                title={
                  markedCount > 0
                    ? `本剧已标记 ${markedCount} 段${skipMark?.enabled === false ? '（本剧跳过已关闭）' : ''}`
                    : '片头 / 中段 / 片尾标记'
                }
              >
                跳过标记{markedCount > 0 ? ` (${markedCount})` : ''}
                {markedCount > 0 && skipMark?.enabled === false && (
                  <span className="ml-1 inline-block size-1.5 rounded-full bg-faint" aria-label="本剧跳过已关闭" />
                )}
              </button>
              {/* 与「跳过标记」并列；整行 flex-wrap，窄屏放不下时自动折成两行。
                  「自动连播」已收进播放器齿轮菜单，这里不再占一行 */}
              <button className="btn-ghost btn-sm" onClick={() => setSwitchOpen(true)}>
                切换资源
              </button>
            </div>

            <SkipMarkPanel
              open={skipPanelOpen}
              onClose={() => setSkipPanelOpen(false)}
              markKey={markKey}
              pendingStart={pendingStart}
              onPendingStart={setPendingStart}
              mobileMaxHeight={sheetMaxHeight}
              getPlayerClock={() => {
                const api = playerApiRef.current;
                if (!api) return null;
                return {
                  currentTime: api.getCurrentTime(),
                  duration: api.getDuration(),
                  seek: (s) => api.seek(s),
                  pause: () => api.pause(),
                  isPaused: () => api.isPaused(),
                };
              }}
            />
          </div>

          {/* 剧集侧栏 */}
          <aside className="bg-surface-raised rounded-lg p-3 h-fit">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <h2 className="text-sm font-semibold text-content">剧集列表</h2>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {/* 排列开关紧贴它所作用的列表：放在这里才看得出它管的是这一栏的顺序 */}
                {episodes.length > 1 && (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => setReversed((v) => !v)}
                    aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                  >
                    <Icon
                      name="arrowDown"
                      className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                    />
                    {reversed ? '正序排列' : '倒序排列'}
                  </button>
                )}
                {episodes.length > 0 && (
                  <button className="btn-ghost btn-sm" onClick={handleDownloadAll}>
                    下载全部（{episodes.length} 集）
                  </button>
                )}
              </div>
            </div>
            {episodes.length === 0 ? (
              detailQuery.isLoading ? (
                <LoadingState />
              ) : (
                <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集信息'} />
              )
            ) : (
              <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-4 gap-1.5 max-h-[65vh] overflow-y-auto scrollbar-thin pr-1">
                {orderedEpisodes.map((realIndex) => (
                  <EpisodeButton
                    key={realIndex}
                    index={realIndex}
                    active={realIndex === currentIndex}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
          </aside>
        </div>
      </main>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          getCurrentPosition={() => playerApiRef.current?.getCurrentTime() ?? 0}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </div>
  );
}

/** 集数按钮：激活时自动滚动进可视区（长剧列表） */
function EpisodeButton({ index, active, onClick }: { index: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={ref}
      className={cn('btn btn-sm !px-1', active ? 'episode-active' : 'btn-ghost')}
      onClick={onClick}
    >
      {index + 1}
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      className="p-2 -ml-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

