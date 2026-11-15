'use client';

import { useMemo, useRef } from 'react';
import { LIVE_PROBE_TTL_MS, useAppStore } from '@/lib/store';

/**
 * 直播频道可用性结果（只读视图）。
 *
 * 探测只发生在「点选频道」时：`app/live/page.tsx` 的 `selectMerged` 对该频道的候选源
 * 发一次 `/api/live/probe`（≤8 个 URL，一次 invocation），结果写回 store。
 * 页面不再提供「测活本列表」这类手动全量测活入口（2026-11-15 用户要求去掉工具栏文案）。
 *
 * - 6 小时内的结果才算有效（`LIVE_PROBE_TTL_MS`），过期条目对 UI 不可见；
 * - 结果对象按 (url, timestamp) 复用身份：写回只更新被探测到的频道，
 *   未变化的条目保持同一对象引用，下游 memo 行组件才能精确跳过重渲染。
 */

export interface ProbeResult {
  ok: boolean;
  ms?: number;
  level?: 'segment' | 'manifest' | 'head';
  error?: string;
  codec?: string;
  /** 因超时失败（源可能只是慢） */
  timedOut?: boolean;
  /** 分片吞吐估算（kbps），低于阈值为「源限速」 */
  kbps?: number;
}

export function useLiveProbeResults(): Map<string, ProbeResult> {
  const cache = useAppStore((s) => s.liveProbeResults);
  const identityRef = useRef(new Map<string, { timestamp: number; result: ProbeResult }>());

  return useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ProbeResult>();
    const identities = identityRef.current;
    for (const [url, e] of Object.entries(cache)) {
      if (now - e.timestamp >= LIVE_PROBE_TTL_MS) continue;
      const known = identities.get(url);
      const result =
        known && known.timestamp === e.timestamp
          ? known.result
          : {
              ok: e.ok,
              ms: e.ms,
              level: e.level,
              error: e.error,
              codec: e.codec,
              timedOut: e.timedOut,
              kbps: e.kbps,
            };
      if (!known || known.timestamp !== e.timestamp) identities.set(url, { timestamp: e.timestamp, result });
      map.set(url, result);
    }
    // 清理已过期频道的身份缓存，避免无界增长
    if (identities.size > map.size) {
      for (const url of identities.keys()) {
        if (!map.has(url)) identities.delete(url);
      }
    }
    return map;
  }, [cache]);
}
