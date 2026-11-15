'use client';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Dropdown } from './dropdown';
import { useAppStore } from '@/lib/store';
import {
  isSlowSource,
  matchesAlive,
  matchesKeyword,
  normalizeForSearch,
  sortChannels,
  type AliveFilter,
  type LiveSortMode,
} from '@/lib/live-channel-filter';
import { bestProbe, type LiveChannelItem, type MergedChannel } from '@/lib/channel-merge';
import { useLiveProbe, type ProbeResult } from './use-live-probe';
import { EmptyState } from './states';

/**
 * 直播频道侧栏：全部/收藏/最近三个视图 + 分组横向标签条 + 关键字搜索 + 排序。
 * - 频道按名称跨源合并（见 lib/channel-merge.ts）：一行 = 一个频道，可能含多个候选源；
 * - 不再进页面自动全量测活：测活改为「选中频道时只探它自己的候选源」，
 *   需要体检整个列表时用工具栏的「测活」按钮（默认不跑）；
 * - 可用性两档筛选（绿点=分片级验证 / 可播=含弱验证）；
 * - 虚拟列表（@tanstack/react-virtual）：仅渲染可视区内的频道行，数千频道下 DOM 恒定，
 *   电视盒子 / 低端设备滑动不掉帧；行高动态测量（有无分组名两档）；
 * - 键盘：容器聚焦后 ↑↓ 移动光标、Enter 播放；
 * - 性能：本组件与 ChannelRow 均精确订阅 store，探测节流写回不会全列表重渲染。
 */

const SEARCH_DEBOUNCE_MS = 200;

/** 测活进度文案：按已完成均速估算剩余时间（长尾在途期间由每秒 tick 重渲染保持走动） */
function formatProbeProgress(p: { done: number; total: number; startedAt: number }): string {
  const base = `${p.done}/${p.total}`;
  const remaining = p.total - p.done;
  if (remaining <= 0) return base;
  if (p.done <= 0) return `${base} · 估算中…`;
  const remainMin = Math.ceil(((Date.now() - p.startedAt) / p.done) * remaining / 60000);
  return `${base} · 预计剩余 ${Math.max(1, remainMin)} 分钟`;
}

export type { LiveChannelItem };

interface ChannelListProps {
  channels: MergedChannel[];
  groups: string[];
  currentUrl: string;
  onSelect: (channel: MergedChannel) => void;
  /** 筛选+排序结果变化时上报（页面级键盘换台沿此列表顺序切换） */
  onFilteredChange?: (list: MergedChannel[]) => void;
  /** 正在为哪一行按需探测候选源（显示「连接中」，避免点了没反应） */
  pickingKey?: string;
}

type View = 'all' | 'fav' | 'recent';

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * 分组标签条：鼠标按住拖动横向滚动 + 左右边缘渐隐。
 *
 * PC 上这条带子只能靠滚动条：`.scrollbar-thin` 把轨道压到 6px 高，
 * 分组一多滑块还会变短，实际点不中（issue #948），所以补一套拖拽。
 * 触摸设备不接管：原生滑动带惯性，比手动跟手好。
 */
function useChipStrip(itemCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  const drag = useRef({ startX: 0, startLeft: 0, moved: false });

  // 边缘渐隐：没有它，用户不知道右边还藏着分组
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      // 拖动时 scroll 事件很密：值没变就复用旧对象，避免每帧重渲染整个频道列表
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [itemCount]);

  // 拖动过程挂 document，而不是 setPointerCapture：
  // 一旦捕获指针，click 会被重定向到容器，点分组就失效了
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const dx = e.clientX - drag.current.startX;
      if (!drag.current.moved && Math.abs(dx) > 3) drag.current.moved = true;
      if (drag.current.moved) el.scrollLeft = drag.current.startLeft - dx;
    };
    const onUp = () => setDragging(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    drag.current = { startX: e.clientX, startLeft: el.scrollLeft, moved: false };
    setDragging(true);
  };

  // 拖完松手仍会触发一次 click，不能让它落到分组按钮上（等于误切分组）
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!drag.current.moved) return;
    drag.current.moved = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { ref, dragging, edges, onPointerDown, onClickCapture };
}

export function LiveChannelList({
  channels,
  groups,
  currentUrl,
  onSelect,
  onFilteredChange,
  pickingKey,
}: ChannelListProps) {
  // 精确订阅：避免任何 store 字段变化（尤其测活节流写回）引发本组件重渲染
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const liveRecent = useAppStore((s) => s.liveRecent);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [view, setView] = useState<View>('all');
  const [group, setGroup] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebouncedValue(keyword, SEARCH_DEBOUNCE_MS);
  const [sortMode, setSortMode] = useState<LiveSortMode>('default');
  // auto 档只在「确实有可用结果」时生效；没有测活数据时等价于全部展示
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('auto');
  /** 键盘光标（filtered 的下标），与"正在播放"高亮独立 */
  const [cursor, setCursor] = useState(-1);
  /** 分组标签条的拖拽滚动与边缘渐隐 */
  const chipStrip = useChipStrip(groups.length);
  const listRef = useRef<HTMLDivElement>(null);
  const {
    results: probeResults,
    progress: probeProgress,
    probe,
    cancel: cancelProbe,
    isProbing,
    hint: probeHint,
  } = useLiveProbe();

  // 测活 ETA 每秒刷新：探测长尾（在途请求未返回）期间进度不推进，剩余时间也要走动
  const [, setProbeTick] = useState(0);
  useEffect(() => {
    if (!isProbing) return;
    const timer = setInterval(() => setProbeTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isProbing]);

  const favSet = useMemo(() => new Set(liveFavorites), [liveFavorites]);
  /** 候选 URL → 合并行：收藏/最近/当前播放都按 URL 反查 */
  const rowByUrl = useMemo(() => {
    const map = new Map<string, MergedChannel>();
    for (const row of channels) for (const candidate of row.candidates) map.set(candidate.url, row);
    return map;
  }, [channels]);
  /** 排序用的「最近观看」序：一行里任一候选看过即算，取最早出现的序号 */
  const recentOrder = useMemo(() => {
    const order = new Map<string, number>();
    liveRecent.forEach((r, i) => {
      const row = rowByUrl.get(r.url);
      if (!row) return;
      const known = order.get(row.url);
      if (known === undefined || i < known) order.set(row.url, i);
    });
    return order;
  }, [liveRecent, rowByUrl]);
  const normalizedKeyword = useMemo(() => normalizeForSearch(debouncedKeyword.trim()), [debouncedKeyword]);
  /** 一行的可用性结论：候选里最好的那个测活结果 */
  const probeOfRow = useCallback(
    (row: MergedChannel) => bestProbe(row, (url) => probeResults.get(url)),
    [probeResults]
  );

  // 先做视图/分组/搜索/排序（不含可用性筛选）：可用性计数必须基于这份列表，
  // 否则点击筛选后 filtered 收缩，两个计数会跟着变小、与实际展示对不上
  const matched = useMemo(() => {
    let list: MergedChannel[];
    if (view === 'fav') {
      list = channels.filter((row) => row.candidates.some((c) => favSet.has(c.url)));
    } else if (view === 'recent') {
      // 按最近观看时间倒序；同一行只保留第一次出现的记录
      const seen = new Set<string>();
      list = [];
      for (const record of liveRecent) {
        const row = rowByUrl.get(record.url);
        if (!row || seen.has(row.key)) continue;
        seen.add(row.key);
        list.push(row);
      }
    } else {
      list = channels;
    }
    if (view !== 'recent' && group) {
      list = list.filter((row) => row.group === group);
    }
    if (normalizedKeyword) {
      list = list.filter(
        (row) =>
          matchesKeyword(row, normalizedKeyword) ||
          row.candidates.some((c) => matchesKeyword(c, normalizedKeyword))
      );
    }
    return sortChannels(list, sortMode, {
      recentOrder,
      probeOf: (url) => {
        const row = rowByUrl.get(url);
        return row ? bestProbe(row, (u) => probeResults.get(u)) : probeResults.get(url);
      },
    });
  }, [channels, favSet, liveRecent, rowByUrl, view, group, normalizedKeyword, sortMode, recentOrder, probeResults]);

  /** 至少有一个频道测活通过时才启用 auto 隐藏：整批失败（源站全挂/本地代理异常）时
      宁可全部展示并标记失败，也不要把列表清空成“什么都看不了” */
  const hasAliveProbe = useMemo(
    () => matched.some((row) => probeOfRow(row)?.ok === true),
    [matched, probeOfRow]
  );
  /** 当前列表里是否已有测活结论（缓存也可能来自别的频道，不能只看 probeResults.size） */
  const hasProbeForList = useMemo(
    () => matched.some((row) => Boolean(probeOfRow(row))),
    [matched, probeOfRow]
  );

  const filtered = useMemo(() => {
    if (aliveFilter === 'off') return matched;
    // auto 档在没有任何可用结果时退化为“全部”，避免测活异常时清空列表
    if (aliveFilter === 'auto' && !hasAliveProbe) return matched;
    return matched.filter((row) => matchesAlive(probeOfRow(row), aliveFilter));
  }, [matched, aliveFilter, probeOfRow, hasAliveProbe]);

  // 上报筛选排序结果给页面（键盘换台用）；列表存父组件 ref，不触发父组件重渲染
  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  // 口径与筛选按钮一致：绿点=分片级验证且吞吐达标（排除限速源），可播=任何验证级别通过
  const aliveCounts = useMemo(() => {
    let ok = 0;
    let green = 0;
    for (const row of matched) {
      const p = probeOfRow(row);
      if (!p?.ok) continue;
      ok++;
      if (matchesAlive(p, 'green')) green++;
    }
    return { ok, green };
  }, [matched, probeOfRow]);

  /** 当前 auto 档隐藏了多少个「已确认不可用」的频道（含超时；没有可用结果时隐藏不生效） */
  const autoHiddenCount = useMemo(() => {
    if (aliveFilter !== 'auto' || !hasAliveProbe) return 0;
    let n = 0;
    for (const row of matched) {
      const p = probeOfRow(row);
      if (p && !p.ok) n++;
    }
    return n;
  }, [aliveFilter, hasAliveProbe, matched, probeOfRow]);

  /** recent 视图里「这一行对应的那条观看记录」：删除时按真实 URL 删 */
  const recentUrlByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of liveRecent) {
      const row = rowByUrl.get(record.url);
      if (row && !map.has(row.key)) map.set(row.key, record.url);
    }
    return map;
  }, [liveRecent, rowByUrl]);

  // 键盘/锚定滚动需要按 URL 反查索引；filtered 随测活结果变化（排序含可用性），
  // 用 ref 读取最新值，避免测活写回触发重新锚定打断用户滚动
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    // 行高两档：带分组名的双行 / 无分组名单行（含 4px 行距），measureElement 会修正估值
    estimateSize: (i) => (filtered[i].group ? 51 : 47),
    overscan: 10,
    getItemKey: (i) => filtered[i].key,
  });

  // 切换筛选/排序/频道时：重置键盘光标，并把当前播放频道锚定到可视区（找不到则回顶部）
  useEffect(() => {
    setCursor(-1);
    if (!currentUrl) {
      virtualizer.scrollToOffset(0);
      return;
    }
    const idx = filteredRef.current.findIndex((row) => row.candidates.some((c) => c.url === currentUrl));
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    else virtualizer.scrollToOffset(0);
  }, [view, group, sortMode, debouncedKeyword, aliveFilter, currentUrl, virtualizer]);

  const scrollToChannelRow = useCallback(
    (url: string) => {
      const idx = filteredRef.current.findIndex((row) => row.candidates.some((c) => c.url === url));
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    },
    [virtualizer]
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const base = cursor === -1 ? (delta === 1 ? -1 : 0) : cursor;
      const next = Math.min(Math.max(base + delta, 0), filtered.length - 1);
      setCursor(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
      return;
    }
    if (e.key === 'Enter' && cursor >= 0 && cursor < filtered.length) {
      // 焦点在行内按钮（收藏/删除）上时，Enter 交给按钮自身
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      onSelect(filtered[cursor]);
    }
  };

  const removeRecent = useCallback((url: string) => {
    useAppStore.getState().removeLiveRecent(url);
  }, []);

  /** 手动体检：只检测当前筛选出来的频道（默认不跑，避免整页 1477 个频道的后台探测） */
  const probeFiltered = useCallback(() => {
    const seen = new Set<string>();
    const urls: { url: string }[] = [];
    for (const row of filtered) {
      for (const candidate of row.candidates) {
        if (seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        urls.push({ url: candidate.url });
      }
    }
    if (urls.length > 0) void probe(urls, { silent: true });
  }, [filtered, probe]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 视图 tab */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-2 border-b border-line shrink-0">
        {(
          [
            ['all', `全部${channels.length ? ` ${channels.length}` : ''}`],
            ['fav', `收藏${liveFavorites.length ? ` ${liveFavorites.length}` : ''}`],
            ['recent', '最近'],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition-colors',
              view === v ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 搜索 + 排序 */}
      <div className="px-3 py-2 shrink-0 flex items-center gap-1.5">
        <input
          className="input w-full !py-1.5 text-xs"
          placeholder="搜索频道"
          value={keyword}
          maxLength={60}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            // 搜索框内按 ↓ 进入列表光标导航
            if (e.key === 'ArrowDown' && filtered.length > 0) {
              e.preventDefault();
              setCursor(0);
              scrollToChannelRow(filtered[0].url);
              listRef.current?.focus();
            }
          }}
        />
        <Dropdown
          className="shrink-0 [&>button]:!py-1.5 [&>button]:!px-2 [&>button]:text-xs"
          value={sortMode}
          ariaLabel="排序方式"
          onChange={(v) => setSortMode(v as LiveSortMode)}
          options={[
            { value: 'default', label: '默认' },
            { value: 'name', label: '名称' },
            { value: 'group', label: '分组' },
            { value: 'probe', label: '可用优先' },
            { value: 'recent', label: '最近看' },
          ]}
        />
      </div>

      {/* 测活：默认不自动跑（进页面全量测活既慢又会撞 Worker CPU 限额）。
          需要体检时点一下「测活本列表」；平时点频道本身只对它的候选源做按需探测。 */}
      <div className="flex items-center gap-1.5 px-3 pb-2 shrink-0 flex-wrap">
        {isProbing ? (
          <>
            <span className="text-[10px] text-faint whitespace-nowrap">
              检测中 {probeProgress ? formatProbeProgress(probeProgress) : ''}
            </span>
            <button
              className="text-[10px] text-faint underline-offset-2 hover:text-content hover:underline"
              onClick={cancelProbe}
              title="中止本次检测，已完成的结果会保留"
            >
              停止
            </button>
          </>
        ) : (
          <button
            className="shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border bg-chip text-muted border-line hover:text-content hover:bg-hover disabled:opacity-50 disabled:hover:bg-chip"
            onClick={probeFiltered}
            disabled={filtered.length === 0}
            title="检测当前列表的频道"
          >
            测活本列表
          </button>
        )}
        {aliveFilter === 'auto' && autoHiddenCount > 0 ? (
          <>
            <span className="text-[10px] text-faint whitespace-nowrap">
              已隐藏 {autoHiddenCount} 个不可用
            </span>
            <button
              className="text-[10px] text-accent underline-offset-2 hover:underline"
              onClick={() => setAliveFilter('off')}
              title="显示全部频道（包括已确认不可用的）"
            >
              显示全部
            </button>
          </>
        ) : aliveFilter === 'auto' && hasProbeForList && !hasAliveProbe ? (
          <span className="text-[10px] text-warning">暂未发现可用频道，已显示全部</span>
        ) : aliveFilter !== 'auto' && hasProbeForList ? (
          <button
            className="text-[10px] text-faint underline-offset-2 hover:text-content hover:underline"
            onClick={() => setAliveFilter('auto')}
            title="恢复自动隐藏不可用频道"
          >
            恢复自动隐藏
          </button>
        ) : null}
        {probeHint && <span className="text-[10px] text-faint">{probeHint}</span>}
        {hasProbeForList && !isProbing && (
          <>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'green'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'green' ? 'auto' : 'green'))}
              title="只看已验证的频道"
            >
              通过 {aliveCounts.green}
            </button>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'ok'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'ok' ? 'auto' : 'ok'))}
              title="看所有验证通过的频道"
            >
              可播 {aliveCounts.ok}
            </button>
          </>
        )}
      </div>

      {/* 分组标签条（横向可滑动：滚轮/滚动条之外，鼠标可直接拖动） */}
      {view === 'all' && groups.length > 0 && (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative">
            <div
              ref={chipStrip.ref}
              onPointerDown={chipStrip.onPointerDown}
              onClickCapture={chipStrip.onClickCapture}
              className={cn(
                // select-none 常驻：拖动时若允许选字，会变成"选中标签文字"而不是滚动
                'flex gap-1.5 overflow-x-auto scrollbar-thin pb-1 select-none',
                chipStrip.dragging ? 'cursor-grabbing' : 'cursor-grab'
              )}
            >
              <GroupChip active={!group} label="全部分组" onClick={() => setGroup('')} />
              {groups.map((g) => (
                <GroupChip key={g} active={group === g} label={g} onClick={() => setGroup(g === group ? '' : g)} />
              ))}
            </div>
            {/* 左右渐隐：提示这一栏还能横向拖动 */}
            {chipStrip.edges.left && (
              <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface-raised to-transparent" />
            )}
            {chipStrip.edges.right && (
              <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface-raised to-transparent" />
            )}
          </div>
        </div>
      )}

      {/* 频道列表（容器可聚焦，↑↓/Enter 光标导航） */}
      <div
        ref={listRef}
        data-channel-list
        tabIndex={0}
        onKeyDown={onListKeyDown}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        {filtered.length === 0 ? (
          <EmptyState
            variant="plain"
            className="!py-10"
            title={
              view === 'fav'
                ? '暂无收藏'
                : view === 'recent'
                  ? '暂无观看记录'
                  : channels.length === 0
                    ? '暂无频道，请先在设置中添加直播源'
                    : aliveFilter === 'auto' && autoHiddenCount > 0
                      ? '没有可用频道'
                      : '没有匹配的频道'
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  // 原 space-y-1 的 4px 行距；padding 计入 measureElement 量得的高度
                  paddingBottom: 4,
                }}
              >
                <ChannelRow
                  channel={filtered[vi.index]}
                  active={filtered[vi.index].candidates.some((c) => c.url === currentUrl)}
                  cursor={cursor === vi.index}
                  isFav={filtered[vi.index].candidates.some((c) => favSet.has(c.url))}
                  favUrls={filtered[vi.index].candidates.filter((c) => favSet.has(c.url)).map((c) => c.url)}
                  probe={probeOfRow(filtered[vi.index])}
                  sourceCount={filtered[vi.index].candidates.length}
                  picking={pickingKey === filtered[vi.index].key}
                  logo={filtered[vi.index].logo}
                  imageProxyMode={imageProxyMode}
                  customProxy={customImageProxy}
                  onSelect={onSelect}
                  onRemoveRecent={view === 'recent' ? removeRecent : undefined}
                  recentUrl={recentUrlByKey.get(filtered[vi.index].key)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        'shrink-0 px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors border',
        active
          ? 'bg-accent text-on-accent border-accent'
          : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const ChannelRow = memo(function ChannelRow({
  channel,
  active,
  cursor,
  isFav,
  favUrls,
  probe,
  sourceCount,
  picking,
  logo,
  imageProxyMode,
  customProxy,
  onSelect,
  onRemoveRecent,
  recentUrl,
}: {
  channel: MergedChannel;
  active: boolean;
  cursor: boolean;
  isFav: boolean;
  /** 该行里已被收藏的候选 URL（取消收藏时逐个移除，避免只删主地址留下别的） */
  favUrls: string[];
  probe?: ProbeResult;
  /** 合并后该频道有几个候选源 */
  sourceCount: number;
  /** 正在对候选源做按需探测（点了之后给个反馈） */
  picking: boolean;
  logo?: string;
  imageProxyMode: 'direct' | 'proxy' | 'custom';
  customProxy: string;
  onSelect: (channel: MergedChannel) => void;
  /** 仅最近视图传入：删除该条观看记录 */
  onRemoveRecent?: (url: string) => void;
  /** 最近视图下这一行对应的观看记录 URL（可能是任意候选） */
  recentUrl?: string;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  // 虚拟列表会复用行实例：换台（logo 变化）时重置失败态，避免下一个频道误显首字母
  useEffect(() => setLogoFailed(false), [logo]);
  // H.265/HEVC：国内 IPTV 常见，测活通过但 Chromium 内核通常无法软解
  const isHevc = Boolean(probe?.codec && /hvc1|hev1|hevc/i.test(probe.codec));
  // 源限速：分片可达但吞吐不足，绿点却播不了的主因
  const slow = isSlowSource(probe);
  // 状态点语义：绿=分片级验证且吞吐达标；琥珀=限速/弱验证（直链/清单级）或超时；红=不可达
  const weakLevel = probe?.ok && probe.level !== 'segment';
  const amber = Boolean(probe && (weakLevel || (!probe.ok && probe.timedOut) || slow));
  const dotClass = amber ? 'bg-warning' : probe?.ok ? 'bg-success' : 'bg-danger';
  const levelText =
    probe?.level === 'segment' ? '分片可用' : probe?.level === 'head' ? '直链可达' : '列表可达';
  const speedText =
    probe?.kbps != null && probe.level === 'segment'
      ? ` · ≈${probe.kbps >= 1000 ? `${(probe.kbps / 1000).toFixed(1)}Mbps` : `${probe.kbps}kbps`}`
      : '';
  const probeTitle = probe
    ? probe.ok
      ? slow
        ? `源限速${speedText.replace(' · ', ' ')}，缓冲跟不上，可能无法流畅播放`
        : `${levelText}${speedText}${probe.ms != null && probe.level === 'segment' ? ` · 延迟 ${probe.ms}ms` : ''}${isHevc ? ' · H.265 编码，需 Edge/Safari' : ''}`
      : probe.timedOut
        ? `${probe.error || '探测超时'} · 源可能只是慢，可直接试播确认`
        : probe.error || '不可用'
    : undefined;

  return (
    <div data-url={channel.url}>
      {/* 不用 role="button"：行内含收藏/删除等真实按钮，嵌套 button 角色语义非法；
          键盘操作由外层列表容器的 ↑↓ 导航提供 */}
      <div
        className={cn(
          'group flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer transition-colors relative',
          active ? 'bg-accent/10' : 'hover:bg-hover',
          cursor && 'ring-1 ring-accent/70'
        )}
        onClick={() => onSelect(channel)}
      >
        {/* 当前播放高亮竖条 */}
        <span
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-accent transition-all duration-200',
            active ? 'h-5 opacity-100' : 'h-0 opacity-0'
          )}
        />
        {/* 台标 */}
        <div className="w-7 h-7 shrink-0 rounded bg-chip flex items-center justify-center overflow-hidden">
          {logo && !logoFailed ? (
            <SmartImage
              url={logo}
              mode={imageProxyMode}
              customProxy={customProxy}
              alt=""
              className="w-full h-full object-contain"
              onExhausted={() => setLogoFailed(true)}
            />
          ) : (
            <span className="text-[10px] text-faint">{channel.name.slice(0, 1)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {picking ? (
              <span className="shrink-0 text-[10px] text-accent whitespace-nowrap">连接中…</span>
            ) : (
              probe && (
                <span
                  className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotClass)}
                  title={probeTitle}
                />
              )
            )}
            <span className={cn('text-xs truncate', active ? 'text-accent font-medium' : 'text-content')}>
              {channel.name}
            </span>
            {sourceCount > 1 && (
              <span
                className="shrink-0 rounded-full bg-chip px-1.5 text-[10px] text-faint"
                title={`${sourceCount} 个来源`}
              >
                {sourceCount} 源
              </span>
            )}
            {isHevc && (
              <span
                className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium text-warning"
                title="H.265 编码：测活通过但 Chromium 内核通常无法解码，建议用 Edge/Safari"
              >
                H.265
              </span>
            )}
          </div>
          {channel.group && (
            <div className="text-[10px] text-faint truncate">{channel.group}</div>
          )}
        </div>
        {/* 最近观看单条删除（仅最近视图；移动端常显） */}
        {onRemoveRecent && (
          <button
            className={cn(
              'shrink-0 p-1 rounded transition-colors',
              'text-faint/60 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 hover:text-danger'
            )}
            aria-label="删除该观看记录"
            title="删除该观看记录"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveRecent(recentUrl ?? channel.url);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {/* 收藏星标（移动端常显，桌面 hover 出现） */}
        <button
          className={cn(
            'shrink-0 p-1 rounded transition-transform active:scale-125',
            isFav
              ? 'text-warning'
              : 'text-faint/60 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 hover:text-warning'
          )}
          aria-label={isFav ? '取消收藏' : '收藏'}
          title={isFav ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            // 点击时读取最新状态：行组件不订阅 store，保证探测期间的重渲染隔离。
            // 合并行可能有多条候选被收藏过：取消时逐个移除，收藏时记主地址。
            const store = useAppStore.getState();
            if (favUrls.length > 0) for (const url of favUrls) store.toggleLiveFavorite(url);
            else store.toggleLiveFavorite(channel.url);
          }}
        >
          <svg className="w-3.5 h-3.5" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
});
