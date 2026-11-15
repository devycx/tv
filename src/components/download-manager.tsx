'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  supportsChunkCache,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { pickSaveTarget, type SaveTarget, UserCancelledError } from '@/lib/download-saver';

/**
 * 全局下载管理器（UI 采用本站 Drawer 模式）：
 * - 入口：header 下载图标 + 播放页「下载本集」（均派发 window 事件）；
 * - 并发：全局最多同时进行 3 个任务，其余排队（waiting）；
 * - 断点：已下载分片写入 Cache Storage（网络层断点）；
 *   保存目标（FS Access / 内存）活不过页面刷新，恢复时由用户点击「继续」重新选择。
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
/** 进度落库节流间隔：整集动辄上千分片，逐片「写库 + 全量查询 + setState」会把长任务页面拖垮 */
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
}

/** 运行中的任务句柄（不进持久化） */
interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
  /** 恢复后需要用户重选保存位置时置 false */
  hasTarget: boolean;
}

/** pickSaveTarget 的用户取消属于正常流程，不应按失败提示；其余异常都要提示并中止后续动作 */
function isUserCancelled(err: unknown): boolean {
  return err instanceof UserCancelledError || (err instanceof Error && err.message.includes('取消'));
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const running = useRef(new Map<string, RunningHandle>());
  /** 已选好、但尚未被 startTask 消费的保存句柄（按任务 id 隔离，避免连续入队互相覆盖） */
  const pendingTargets = useRef(new Map<string, SaveTarget>());

  /** 关闭并移除尚未被消费的保存句柄，防止 FileSystemWritableFileStream 文件锁泄漏 */
  const discardPendingTarget = useCallback(async (id: string) => {
    const target = pendingTargets.current.get(id);
    if (!target) return;
    pendingTargets.current.delete(id);
    try {
      await target.abort();
    } catch {
      /* 忽略关闭异常 */
    }
  }, []);

  // 组件卸载时释放所有未消费的保存句柄，防止文件写锁泄漏
  useEffect(() => {
    const targets = pendingTargets.current;
    return () => {
      for (const target of targets.values()) {
        void target.abort().catch(() => {});
      }
      targets.clear();
    };
  }, []);

  const refresh = useCallback(() => {
    void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks);
  }, []);

  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);

  // —— 任务启动：选目标 → runDownloadJob（全程直连源站） ——
  const startTask = useCallback(
    async (entry: DownloadTaskEntry, hasTarget: boolean) => {
      if (running.current.has(entry.id)) return;
      const abort = new AbortController();
      const pause = new PauseResumeController();
      running.current.set(entry.id, { abort, pause, hasTarget });

      // 消费并移出待用句柄：无论本次是否真正使用，都从 Map 移除，避免被后续调度重复消费
      const target = pendingTargets.current.get(entry.id);
      pendingTargets.current.delete(entry.id);
      const effectiveTarget: SaveTarget =
        hasTarget && target
          ? target
          : {
              // 目标已失效（页面刷新后句柄消亡）：显式报错引导用户点「继续」重选，
              // 绝不能静默空写——否则任务会显示完成却产出空文件
              kind: 'memory',
              write: async () => {
                throw new Error('保存位置已失效，请点击「继续」重新选择');
              },
              close: async () => {},
              abort: async () => {},
            };

      try {
        await updateEntry(entry.id, { status: 'downloading' });

        // 进度：UI 走本地 state 实时刷新，落库按固定间隔节流。整集动辄上千分片，
        // 逐片 updateEntry（写库 + 全量查询 + setState）会让页面越下越卡，
        // 极端情况下长任务被浏览器判定为无响应
        let lastPersistAt = 0;
        const onProgress = (p: DownloadProgress) => {
          const status = p.status === 'done' ? 'completed' : p.status === 'error' ? 'error' : 'downloading';
          setTasks((prev) => prev.map((t) => (t.id === entry.id ? { ...t, finished: p.current, total: p.total, status } : t)));
          const now = Date.now();
          // 状态切换（完成/失败/处理中）必须立刻持久化，纯进度才节流
          if (p.status === 'downloading' && now - lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) return;
          lastPersistAt = now;
          void db.downloads.update(entry.id, { finished: p.current, total: p.total, status, updatedAt: now });
        };

        const job = runDownloadJob({
          taskId: entry.id,
          url: entry.url,
          title: entry.title,
          format: entry.format,
          signal: abort.signal,
          pause,
          onProgress,
          target: effectiveTarget,
        });

        void job
          .then(async () => {
            await updateEntry(entry.id, { status: 'completed' });
            void clearDownloadChunks(entry.id);
            toast(`《${entry.title}》下载完成`, 'success');
          })
          .catch(async (err: Error) => {
            if (abort.signal.aborted) return; // 用户取消：状态已在取消处理里写好
            await updateEntry(entry.id, { status: 'error' });
            toast(`《${entry.title}》下载失败：${err.message}`, 'error');
          })
          .finally(() => {
            running.current.delete(entry.id);
            scheduleNext();
          });
      } catch (err) {
        // 启动阶段同步失败（如写库异常）：清运行态并释放刚消费的句柄，
        // 否则 running 残留会让该任务永远无法重新调度
        running.current.delete(entry.id);
        await effectiveTarget.abort().catch(() => {});
        await updateEntry(entry.id, { status: 'error' }).catch(() => {});
        toast(`《${entry.title}》启动失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
        scheduleNext();
      }
    },
    // scheduleNext 刻意不进依赖：它与 startTask 相互引用，进依赖会让回调每帧重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, updateEntry]
  );

  // —— 全局并发调度 ——
  const scheduleNext = useCallback(() => {
    void (async () => {
      const runningCount = running.current.size;
      if (runningCount >= MAX_CONCURRENT_DOWNLOADS) return;
      const all = await db.downloads.orderBy('createdAt').toArray();
      const waiting = all.filter((t) => t.status === 'waiting' && !running.current.has(t.id));
      for (const t of waiting.slice(0, MAX_CONCURRENT_DOWNLOADS - runningCount)) {
        const entry = t;
        // 有待用句柄（本次会话内已选好保存位置）就交给 startTask 消费；
        // 否则 startTask 以「目标已失效」兜底，提示用户点「继续」重选
        void startTask({ ...entry, format: entry.format }, pendingTargets.current.has(entry.id));
      }
    })();
  }, [startTask]);

  // —— 事件：新增任务（用户手势内触发，可安全弹文件选择器） ——
  // 监听器必须常驻：播放页「下载本集」在抽屉关闭时也会派发事件，
  // 若仅 isOpen 时注册，事件会凭空丢失——toast 提示了入队，实际什么都没发生
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      // 无 Cache Storage（HTTP 访问 / 老浏览器）时下载必然失败——分片无处暂存。
      // 在入队这一步就讲清楚，别让用户等到任务跑到一半才看到报错
      if (!supportsChunkCache()) {
        toast('当前环境不支持下载缓存（需通过 HTTPS 访问），无法下载', 'error');
        return;
      }
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: DownloadTaskEntry = {
          id,
          url: detail.url,
          title: detail.title,
          format,
          status: 'waiting',
          finished: 0,
          total: 0,
          errorNum: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        // 用户手势内预选保存目标（FS Access 弹窗必须在手势内）
        let picked: SaveTarget;
        try {
          picked = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
        } catch (err) {
          if (isUserCancelled(err)) {
            toast('已取消下载', 'info');
            return;
          }
          // 选择失败不能继续入队：没有保存目标的任务注定写出失败
          toast(`选择保存位置失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
          return;
        }
        pendingTargets.current.set(id, picked);
        try {
          await db.downloads.put(entry);
        } catch (err) {
          // 任务没建成：立刻释放已打开的写入流，避免文件锁泄漏
          await discardPendingTarget(id);
          toast(`创建下载任务失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
          return;
        }
        refresh();
        scheduleNext();
        toast(`《${detail.title}》已加入下载队列`, 'success');
      })();
    };

    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => {
      window.removeEventListener(ADD_TASK_EVENT, onAdd);
    };
  }, [discardPendingTarget, refresh, scheduleNext, toast]);

  // 抽屉打开时：刷新任务列表，并启动排队中的任务
  useEffect(() => {
    if (!isOpen) return;
    refresh();
    // 刷新页面/重开抽屉后，上次被中断的任务在库里仍是「下载中」但没有运行句柄。
    // 统一改回「已暂停」：用户能看到真实状态，也能点「继续」接着下（分片缓存还在），
    // 而不是卡在永远 100% 不动也不会自动跑的状态。
    void (async () => {
      try {
        const stale = await db.downloads.where('status').equals('downloading').toArray();
        const orphans = stale.filter((t) => !running.current.has(t.id));
        if (orphans.length === 0) return;
        await Promise.all(
          orphans.map((t) => db.downloads.update(t.id, { status: 'paused', updatedAt: Date.now() }))
        );
        refresh();
      } catch {
        /* IndexedDB 不可用时忽略，不影响正常下载 */
      }
    })();
    scheduleNext();
  }, [isOpen, refresh, scheduleNext]);

  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle && entry.status === 'downloading') {
      handle.pause.pause();
      await updateEntry(entry.id, { status: 'paused' });
      return;
    }
    if (entry.status === 'paused' || entry.status === 'waiting' || entry.status === 'error') {
      // 恢复：需要用户手势内重选保存目标（浏览器限制）
      if (running.current.has(entry.id)) return;
      // 重选前先关闭旧的未消费句柄，避免旧文件写锁泄漏
      await discardPendingTarget(entry.id);
      let picked: SaveTarget;
      try {
        picked = await pickSaveTarget(`${entry.title}.${entry.format.toLowerCase()}`);
      } catch (err) {
        if (isUserCancelled(err)) {
          toast('已取消', 'info');
          return;
        }
        toast(`选择保存位置失败：${err instanceof Error ? err.message : '未知错误'}`, 'error');
        return;
      }
      // 文件选择器是异步的：等待期间任务可能已被调度器启动
      if (running.current.has(entry.id)) {
        await picked.abort().catch(() => {});
        return;
      }
      pendingTargets.current.set(entry.id, picked);
      await updateEntry(entry.id, { status: 'waiting' });
      scheduleNext();
      return;
    }
    void handle; // downloading 且无 handle：状态漂移，等待调度器自愈
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    running.current.get(entry.id)?.abort.abort();
    running.current.delete(entry.id);
    // 排队中/等待恢复的任务可能还没有运行句柄，但已有未消费的保存句柄要释放
    await discardPendingTarget(entry.id);
    await clearDownloadChunks(entry.id);
    await db.downloads.delete(entry.id);
    refresh();
    // 终态（已完成/失败）删的是记录而非终止任务；文件已保存在用户选择的位置，不受影响
    toast(
      entry.status === 'completed' || entry.status === 'error'
        ? `《${entry.title}》已删除下载记录`
        : `《${entry.title}》已取消下载`,
      'info'
    );
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    waiting: '排队中',
    downloading: '下载中',
    paused: '已暂停',
    completed: '已完成',
    error: '失败',
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-lg">
      <div className="space-y-3">
        {tasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">暂无下载任务</div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-content truncate">{t.title}</p>
                <p className="text-xs text-faint">
                  {t.format.toUpperCase()} · {statusLabel[t.status]}
                  {t.status === 'downloading' && t.total > 0 ? ` · ${t.finished}/${t.total}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {t.status === 'downloading' && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    暂停
                  </button>
                )}
                {(t.status === 'paused' || t.status === 'waiting' || t.status === 'error') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    继续
                  </button>
                )}
                <button
                  type="button"
                  aria-label="删除下载任务"
                  className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                  onClick={() => void onCancel(t)}
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              </div>
            </div>
            {(t.status === 'downloading' || t.status === 'paused' || t.status === 'completed') && t.total > 0 && (
              <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}

/** 播放页等处调用：把一集加入下载队列（必须在用户手势内调用） */
export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

/** header 等处调用：打开下载管理器 */
export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

/** 全局挂载点：根布局渲染一次，监听打开事件 */
export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}

