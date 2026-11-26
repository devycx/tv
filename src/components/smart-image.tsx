'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { buildImageCandidates } from '@/lib/utils';

interface SmartImageProps {
  /** 原始图片地址（未经代理加工，降级链由本组件按加载方式生成） */
  url?: string;
  mode: 'direct' | 'proxy' | 'custom';
  customProxy?: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  /** 首屏关键图给 high，其余 auto；仅影响浏览器下载优先级 */
  fetchPriority?: 'high' | 'low' | 'auto';
  /** 候选链耗尽后回调，调用方切换占位图等兜底 UI */
  onExhausted?: () => void;
  /** 当前候选图真正解码成功；cacheHit=true 表示浏览器缓存命中，可直接显示、跳过淡入 */
  onLoad?: (cacheHit?: boolean) => void;
}

/** 浏览器已在挂载前完成解码时，在首帧前补发 onLoad，避免缓存命中还闪一下 shimmer。 */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * 带降级链的封面图组件：按 buildImageCandidates 的顺序加载，onError 逐级回退
 * （豆瓣图：公共镜像 → 原站直连）。全部失败后触发 onExhausted，由调用方展示占位图。
 * 封面全部由浏览器直连，不经本站 Worker；referrerPolicy=no-referrer 规避部分图床的 Referer 校验。
 */
export function SmartImage({
  url,
  mode,
  customProxy = '',
  alt,
  className,
  loading = 'lazy',
  fetchPriority = 'auto',
  onExhausted,
  onLoad,
}: SmartImageProps) {
  const candidates = buildImageCandidates(url, mode, customProxy);
  const candidateKey = `${url ?? ''}\u0000${mode}\u0000${customProxy}`;
  /** 进度与候选链绑定：url/mode 变化的同一帧就回到第 0 张，不会先消费旧下标。 */
  const [progress, setProgress] = useState({ key: candidateKey, index: 0 });
  const idx = progress.key === candidateKey ? progress.index : 0;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const onLoadRef = useRef(onLoad);
  const onExhaustedRef = useRef(onExhausted);
  onLoadRef.current = onLoad;
  onExhaustedRef.current = onExhausted;

  const advance = (): void => {
    setProgress((prev) => ({
      key: candidateKey,
      index: (prev.key === candidateKey ? prev.index : 0) + 1,
    }));
  };

  const src = candidates[idx];

  /**
   * 缓存命中时浏览器不会补发 load 事件：按 src 补查一次，已成功则带上 cacheHit=true。
   * 失败则推进候选链；SVG 可以合法地没有固有尺寸，不能按坏图处理。
   */
  useBrowserLayoutEffect(() => {
    const el = imgRef.current;
    if (!el || !el.complete) return;
    if (el.naturalWidth > 0) onLoadRef.current?.(true);
    else if (!/\.svg(?:[?#]|$)/i.test(src ?? '')) advance();
  }, [src]);

  useEffect(() => {
    if (idx >= candidates.length) onExhaustedRef.current?.();
  }, [idx, candidates.length]);

  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => onLoadRef.current?.(false)}
      onError={advance}
    />
  );
}
