'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { copyToClipboard } from '@/lib/clipboard';
import { Header } from '@/components/header';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
import dynamic from 'next/dynamic';
const LivePlayer = dynamic(() => import('@/components/live-player').then((m) => m.LivePlayer), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <Spinner size="lg" />
    </div>
  ),
});
import { LiveChannelList } from '@/components/live-channel-list';
import { mergeChannels, type LiveChannelItem, type MergedChannel } from '@/lib/channel-merge';
import { LiveEpgPanel } from '@/components/live-epg-panel';
import { Spinner } from '@/components/states';
import { useAuth } from '@/components/auth';
import { allLiveSources, useAppStore, type LiveProbeEntry } from '@/lib/store';
import { collectGroups } from '@/lib/m3u-parser';
import { cn } from '@/lib/utils';
import { SmartImage } from '@/components/smart-image';

/**
 * 直播页：左侧播放器 + 频道信息 + 节目单；右侧频道侧栏。
 * 状态由 URL 驱动（?url=&name=&group=&tvgId=&epg=），支持频道深链与刷新保持。
 * 换台路径：侧栏点击、全局 ↑↓ 键盘、播放器控制条上一台/下一台（全屏可用）。
 * 移动端频道列表直接展开在播放器下方（页内滚动），选中频道后不收起。
 */
export default function LivePage() {
  return (
    <Suspense>
      <LiveContent />
    </Suspense>
  );
}

function LiveContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // 精确订阅所需字段：任何其他 store 变化（如测活写回）不应触发本组件重渲染
  const liveSelectedUrls = useAppStore((s) => s.liveSelectedUrls);
  const liveEnvSources = useAppStore((s) => s.liveEnvSources);
  const liveSubscriptions = useAppStore((s) => s.liveSubscriptions);
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const volumeBoost = useAppStore((s) => s.volumeBoost);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { verified } = useAuth();
  const [copied, setCopied] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  /** 上一个频道名：只在确实有历史时渲染「返回上一个」按钮（ref 不触发重渲染，故另存一份名称） */
  const [lastChannelName, setLastChannelName] = useState<string | null>(null);
  /** 手机端「更多频道操作」菜单（上一台/下一台收进来，给标题让位） */
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  /** 侧栏上报的筛选排序结果（键盘换台沿此列表顺序）；ref 存储，不触发重渲染 */
  const filteredRef = useRef<MergedChannel[]>([]);
  /** 当前频道镜像：selectChannel 内读取最近一次播放的频道，用于记录"上一个频道" */
  const currentChannelRef = useRef<LiveChannelItem | undefined>(undefined);
  /** 上一个频道：退格键/按钮一键切回（电视遥控器 back 键习惯） */
  const lastChannelRef = useRef<LiveChannelItem | null>(null);

  // 「更多」菜单：点外部 / Esc 收起
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  // 仅聚合已启用的直播源（设置 → 直播源中的勾选状态）
  const sources = useMemo(() => {
    const selected = new Set(liveSelectedUrls);
    return allLiveSources({ liveEnvSources, liveSubscriptions }).filter((s) => selected.has(s.url));
  }, [liveSelectedUrls, liveEnvSources, liveSubscriptions]);

  // 聚合全部直播源的 M3U 解析结果（单源失败不影响整体）
  // api.livePlaylistAuto：浏览器直连上游列表（12 个预置源均允许跨域），失败才回退服务端代理
  const playlistsQuery = useQuery({
    queryKey: ['livePlaylists', sources.map((s) => s.url).join('|')],
    queryFn: async () => {
      const results = await Promise.allSettled(sources.map((s) => api.livePlaylistAuto(s.url)));
      return sources.map((source, i) => ({ source, result: results[i] }));
    },
    enabled: verified && sources.length > 0,
    staleTime: 10 * 60_000,
  });

  const { channels, merged, groups, failedCount } = useMemo(() => {
    const list: LiveChannelItem[] = [];
    const seen = new Set<string>();
    let failed = 0;
    for (const { source, result } of playlistsQuery.data ?? []) {
      if (result.status !== 'fulfilled') {
        failed++;
        continue;
      }
      for (const c of result.value.channels) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        list.push({ ...c, epg: source.epg, sourceUrl: source.url });
      }
    }
    // 跨源按频道名/tvg-id 合并：一个频道一行，候选源列表供点选时按需探测
    const mergedList = mergeChannels(list);
    return { channels: list, merged: mergedList, groups: collectGroups(mergedList), failedCount: failed };
  }, [playlistsQuery.data]);

  // 当前频道：优先取列表内完整对象（含台标），否则由 URL 参数重建
  const currentUrl = searchParams.get('url') || '';
  /** 当前播放地址所属的合并频道：换源、源数量、「换源」按钮都靠它 */
  const currentRow = useMemo(
    () => merged.find((row) => row.candidates.some((c) => c.url === currentUrl)),
    [merged, currentUrl]
  );
  const currentChannel = useMemo(() => {
    const inRow = currentRow?.candidates.find((c) => c.url === currentUrl);
    if (inRow) return inRow;
    const found = channels.find((c) => c.url === currentUrl);
    if (found) return found;
    if (!currentUrl) return undefined;
    return {
      id: searchParams.get('tvgId') || currentUrl,
      url: currentUrl,
      name: searchParams.get('name') || '未知频道',
      group: searchParams.get('group') || undefined,
      tvgId: searchParams.get('tvgId') || undefined,
      epg: searchParams.get('epg') || undefined,
    } as LiveChannelItem;
  }, [channels, currentRow, currentUrl, searchParams]);

  useEffect(() => {
    setLogoFailed(false);
  }, [currentChannel?.url]);
  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  const selectChannel = useCallback(
    (c: LiveChannelItem) => {
      const cur = currentChannelRef.current;
      if (cur && cur.url !== c.url) {
        lastChannelRef.current = cur;
        setLastChannelName(cur.name);
      }
      setMoreOpen(false);
      const sp = new URLSearchParams({ url: c.url, name: c.name });
      if (c.group) sp.set('group', c.group);
      if (c.tvgId) sp.set('tvgId', c.tvgId);
      if (c.epg) sp.set('epg', c.epg);
      router.replace(`/live?${sp.toString()}`, { scroll: false });
      useAppStore.getState().addLiveRecent({
        url: c.url,
        name: c.name,
        logo: c.logo,
        group: c.group,
        tvgId: c.tvgId,
        epg: c.epg,
        sourceUrl: c.sourceUrl,
      });
    },
    [router]
  );

  /** 当前播放地址的最新值（selectMerged 里要读，避免闭包过期） */
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;

  /** 正在按需探测候选源的频道 key：列表据此显示「连接中」 */
  const [pickingKey, setPickingKey] = useState('');
  /** 按需探测的竞态令牌：连续点不同频道时只让最后一次生效 */
  const pickTokenRef = useRef(0);

  /**
   * 选中一个合并频道：
   * - 只有 1 个候选源：直接播，不发任何探测请求；
   * - 多个候选：缓存里有可用结果就直接播；否则发一次 /api/live/probe（≤8 个 URL，一次 invocation），
   *   选第一个可用的播；全失败也照播第一个（探测存在假阴性）。
   * - 再点一次正在播的频道 = 换到下一个源。
   */
  const selectMerged = useCallback(
    (row: MergedChannel) => {
      const candidates = row.candidates;
      if (candidates.length === 0) return;
      const token = ++pickTokenRef.current;
      const nowUrl = currentUrlRef.current;
      const currentIndex = candidates.findIndex((c) => c.url === nowUrl);
      const ordered =
        currentIndex >= 0
          ? [...candidates.slice(currentIndex + 1), ...candidates.slice(0, currentIndex)]
          : candidates;
      if (ordered.length === 1) {
        setPickingKey('');
        selectChannel(ordered[0]);
        return;
      }
      const cached = useAppStore.getState().liveProbeResults;
      const cachedOk = ordered.find((c) => cached[c.url]?.ok);
      if (cachedOk) {
        setPickingKey('');
        selectChannel(cachedOk);
        return;
      }
      setPickingKey(row.key);
      void (async () => {
        try {
          const { results } = await api.liveProbe(ordered.slice(0, 8).map((c) => c.url));
          if (pickTokenRef.current !== token) return;
          const entries: Record<string, LiveProbeEntry> = {};
          for (const r of results) {
            entries[r.url] = {
              ok: r.ok,
              ms: r.ms,
              level: r.level,
              error: r.error,
              codec: r.codec,
              timedOut: r.timedOut,
              kbps: r.kbps,
              timestamp: Date.now(),
            };
          }
          if (Object.keys(entries).length > 0) useAppStore.getState().setLiveProbeResults(entries);
          const okCandidate = ordered.find((c) => results.some((r) => r.url === c.url && r.ok));
          selectChannel(okCandidate ?? ordered[0]);
        } catch {
          if (pickTokenRef.current !== token) return;
          // 探测本身失败不该挡住播放：直接试第一个
          selectChannel(ordered[0]);
        } finally {
          if (pickTokenRef.current === token) setPickingKey('');
        }
      })();
    },
    [selectChannel]
  );

  const handleFilteredChange = useCallback((list: MergedChannel[]) => {
    filteredRef.current = list;
  }, []);

  /** 沿侧栏当前筛选排序的列表顺序切上一台/下一台（循环） */
  const switchChannelByOffset = useCallback(
    (delta: 1 | -1) => {
      const list = filteredRef.current;
      if (list.length === 0) return;
      const nowUrl = new URLSearchParams(window.location.search).get('url') || '';
      const idx = list.findIndex((row) => row.candidates.some((c) => c.url === nowUrl));
      const next =
        idx === -1 ? (delta === 1 ? 0 : list.length - 1) : (idx + delta + list.length) % list.length;
      selectMerged(list[next]);
    },
    [selectMerged]
  );

  const goPrevChannel = useCallback(() => switchChannelByOffset(-1), [switchChannelByOffset]);
  const goNextChannel = useCallback(() => switchChannelByOffset(1), [switchChannelByOffset]);

  /** 切回上一个频道（Backspace / 信息条按钮） */
  const backToPrevChannel = useCallback(() => {
    const prev = lastChannelRef.current;
    if (!prev) return;
    lastChannelRef.current = null;
    setLastChannelName(null);
    selectChannel(prev);
  }, [selectChannel]);

  // 全局键盘：↑↓ 直接切台，Backspace 切回上一个频道。
  // 输入框/列表光标导航场景让位（列表聚焦时由列表内 ↑↓ 管理光标）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isChannelKey = e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Backspace';
      if (!isChannelKey) return;
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.closest('[data-channel-list]')) return;
      }
      e.preventDefault();
      if (e.key === 'Backspace') backToPrevChannel();
      else switchChannelByOffset(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [switchChannelByOffset, backToPrevChannel]);

  if (!verified) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-faint text-sm">等待访问验证...</p>
        </div>
      </div>
    );
  }

  const logo = currentChannel?.logo;
  const isFavorite = currentChannel ? liveFavorites.includes(currentChannel.url) : false;
  /** 没有 EPG 配置的频道直接不渲染节目单卡片（空态文案占一整张卡，信息量为零） */
  const hasEpg = Boolean(currentChannel?.epg && currentChannel.tvgId);

  return (
    <div className="min-h-screen flex flex-col">
      <Header showSearch />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] lg:gap-4 lg:items-start">
          {/* 主栏：播放器 + 信息条 + 节目单。手机端用 display:contents 把三块摊平，
              以便频道列表插在信息条与节目单之间（见下方 order 类） */}
          <div className="min-w-0 max-lg:contents">
            <div className="aspect-video bg-black rounded-lg overflow-hidden max-lg:order-1">
              {currentUrl ? (
                <LivePlayer
                  url={currentUrl}
                  title={currentChannel?.name || '直播'}
                  onPrevChannel={goPrevChannel}
                  onNextChannel={goNextChannel}
                  volumeBoost={volumeBoost}
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-black">
                  {(sources.length === 0 || playlistsQuery.isLoading) && (
                    <>
                      <span className="live-dot" />
                      <p className="text-white/60 text-sm">{sources.length === 0 ? '暂无直播源' : '加载中…'}</p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* 频道信息条 */}
            {currentChannel && (
              <div className="bg-surface-raised border border-line rounded-lg p-3 mt-3 flex items-center gap-3 max-lg:order-2">
                <div className="w-10 h-10 shrink-0 rounded bg-chip flex items-center justify-center overflow-hidden">
                  {logo && !logoFailed ? (
                    <SmartImage
                      url={logo}
                      mode={imageProxyMode}
                      customProxy={customImageProxy}
                      alt=""
                      className="w-full h-full object-contain"
                      onExhausted={() => setLogoFailed(true)}
                    />
                  ) : (
                    <span className="text-xs text-faint">{currentChannel.name.slice(0, 1)}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="live-dot shrink-0" />
                    <h1 className="text-sm font-semibold text-content truncate" title={currentChannel.name}>
                      {currentChannel.name}
                    </h1>
                    {currentChannel.group && (
                      <span className="tag bg-chip text-faint shrink-0 hidden sm:inline-flex">
                        {currentChannel.group}
                      </span>
                    )}
                    {currentRow && currentRow.candidates.length > 1 && (
                      <span
                        className="shrink-0 rounded-full bg-chip px-1.5 text-[10px] text-faint"
                        title={`共 ${currentRow.candidates.length} 个来源`}
                      >
                        {currentRow.candidates.length} 源
                      </span>
                    )}
                  </div>
                  {/* 手机上不展示完整流地址：占宽且无信息价值，横屏/桌面再显示 */}
                  <p className="text-xs text-faint truncate mt-0.5 hidden sm:block">{currentChannel.url}</p>
                  {currentChannel.group && (
                    <p className="text-xs text-faint truncate mt-0.5 sm:hidden">{currentChannel.group}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* 换源：同一频道有多个来源时，一键切到下一个（播放失败时的兜底） */}
                  {currentRow && currentRow.candidates.length > 1 && (
                    <button
                      className="hidden lg:inline-flex items-center rounded-md px-2 py-1 text-[11px] text-muted hover:text-accent hover:bg-hover transition-colors"
                      aria-label="切换到下一个来源"
                      title={`换源：共 ${currentRow.candidates.length} 个来源`}
                      onClick={() => selectMerged(currentRow)}
                    >
                      换源
                    </button>
                  )}
                  {/* 返回上一个频道只在确实有历史时出现；手机上收进「更多」太深，直接不显示 */}
                  {lastChannelName && (
                    <button
                      className="hidden sm:inline-flex rounded-md p-2 text-muted hover:text-accent hover:bg-hover transition-colors"
                      aria-label="上一个频道"
                      title={`上一个频道：${lastChannelName}（Backspace）`}
                      onClick={backToPrevChannel}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 15L4 10l5-5m-5 5h10.5a5.5 5.5 0 015.5 5.5V17"
                        />
                      </svg>
                    </button>
                  )}
                  {/* 上一台/下一台在桌面直接露出；手机收进「更多」，把标题宽度让出来 */}
                  <button
                    className="hidden sm:inline-flex rounded-md p-2 text-muted hover:text-accent hover:bg-hover transition-colors"
                    aria-label="上一台"
                    title="上一台（↑）"
                    onClick={goPrevChannel}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <button
                    className="hidden sm:inline-flex rounded-md p-2 text-muted hover:text-accent hover:bg-hover transition-colors"
                    aria-label="下一台"
                    title="下一台（↓）"
                    onClick={goNextChannel}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 5l7 7-7 7M5 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                  <button
                    className={cn(
                      'rounded-md p-2 transition-colors',
                      isFavorite ? 'text-warning' : 'text-muted hover:text-warning hover:bg-hover'
                    )}
                    aria-label={isFavorite ? '取消收藏' : '收藏'}
                    title={isFavorite ? '取消收藏' : '收藏'}
                    onClick={() => useAppStore.getState().toggleLiveFavorite(currentChannel.url)}
                  >
                    <svg
                      className="w-4 h-4"
                      fill={isFavorite ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                      />
                    </svg>
                  </button>
                  <button
                    className="rounded-md p-2 text-muted hover:text-accent hover:bg-hover transition-colors"
                    aria-label="复制播放地址"
                    title="复制播放地址"
                    onClick={async () => {
                      const ok = await copyToClipboard(currentChannel.url);
                      if (ok) {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }
                    }}
                  >
                    {copied ? (
                      <span className="text-[10px] text-success">已复制</span>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3"
                        />
                      </svg>
                    )}
                  </button>
                  <div ref={moreRef} className="relative sm:hidden">
                    <button
                      className={cn(
                        'rounded-md p-2 transition-colors',
                        moreOpen ? 'bg-hover text-content' : 'text-muted hover:bg-hover hover:text-content'
                      )}
                      aria-label="更多频道操作"
                      aria-haspopup="menu"
                      aria-expanded={moreOpen}
                      onClick={() => setMoreOpen((v) => !v)}
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="5" r="1.8" />
                        <circle cx="12" cy="12" r="1.8" />
                        <circle cx="12" cy="19" r="1.8" />
                      </svg>
                    </button>
                    {moreOpen && (
                      <div
                        role="menu"
                        aria-label="频道操作"
                        className="absolute right-0 top-full z-20 mt-1 w-28 overflow-hidden rounded-lg border border-line bg-surface-raised py-1 shadow-xl animate-fade-in"
                      >
                        <button
                          role="menuitem"
                          className="flex w-full items-center px-3 py-2 text-left text-xs text-content transition-colors hover:bg-hover"
                          onClick={() => {
                            setMoreOpen(false);
                            goPrevChannel();
                          }}
                        >
                          上一台
                        </button>
                        <button
                          role="menuitem"
                          className="flex w-full items-center px-3 py-2 text-left text-xs text-content transition-colors hover:bg-hover"
                          onClick={() => {
                            setMoreOpen(false);
                            goNextChannel();
                          }}
                        >
                          下一台
                        </button>
                        {currentRow && currentRow.candidates.length > 1 && (
                          <button
                            role="menuitem"
                            className="flex w-full items-center px-3 py-2 text-left text-xs text-content transition-colors hover:bg-hover"
                            onClick={() => {
                              setMoreOpen(false);
                              selectMerged(currentRow);
                            }}
                          >
                            换源（{currentRow.candidates.length}）
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 节目单：无 EPG 配置时不渲染整张卡 */}
            {currentChannel && hasEpg && (
              <section className="bg-surface-raised border border-line rounded-lg p-3 mt-3 max-lg:order-4">
                <h2 className="text-sm font-semibold text-content mb-2.5">节目单</h2>
                <LiveEpgPanel epgUrl={currentChannel.epg} tvgId={currentChannel.tvgId} />
              </section>
            )}
          </div>

          {/* 频道列表：手机直接展开在播放器下方（页内滚动）；桌面为右侧常驻栏 */}
          <aside
            className={cn(
              'mt-4 flex flex-col overflow-hidden rounded-xl border border-line bg-surface-raised max-lg:order-3',
              'h-[62vh] min-h-[18rem]',
              'lg:sticky lg:top-20 lg:mt-0 lg:h-[calc(100vh-6.5rem)]'
            )}
          >
            <div className="flex-1 min-h-0 flex flex-col">
              {playlistsQuery.isLoading && channels.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <Spinner size="lg" />
                </div>
              ) : (
                <LiveChannelList
                  channels={merged}
                  groups={groups}
                  currentUrl={currentUrl}
                  onSelect={selectMerged}
                  onFilteredChange={handleFilteredChange}
                  pickingKey={pickingKey}
                />
              )}
              {failedCount > 0 && (
                <p className="text-[10px] text-faint px-3 py-1.5 border-t border-line shrink-0">
                  {failedCount} 个订阅拉取失败
                </p>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
