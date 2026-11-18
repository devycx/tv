'use client';

import { useEffect, useRef, useState } from 'react';
import { buildImageCandidates } from '@/lib/utils';

interface SmartImageProps {
  /** 原始图片地址（未经代理加工，降级链由本组件按加载方式生成） */
  url?: string;
  mode: 'direct' | 'proxy' | 'custom';
  customProxy?: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  /** 候选链耗尽后回调，调用方切换占位图等兜底 UI */
  onExhausted?: () => void;
  /** 当前候选图真正解码成功（可用于「图加载好再显示卡片」，避免灰色占位闪现） */
  onLoad?: () => void;
}

/**
 * 带降级链的封面图组件：按 buildImageCandidates 的顺序加载，onError 逐级回退
 * （豆瓣图：公共镜像 → 原站直连）。全部失败后触发 onExhausted 并停止渲染，由调用方展示占位图。
 * 封面全部由浏览器直连，不经本站 Worker；referrerPolicy=no-referrer 规避部分图床的 Referer 校验。
 */
export function SmartImage({
  url,
  mode,
  customProxy = '',
  alt,
  className,
  loading = 'lazy',
  onExhausted,
  onLoad,
}: SmartImageProps) {
  const candidates = buildImageCandidates(url, mode, customProxy);
  const [idx, setIdx] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // 回调放进 ref：父级常传内联函数，直接进 effect 依赖会反复执行
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  // 地址或加载方式变化时重置降级进度
  useEffect(() => setIdx(0), [url, mode, customProxy]);
  useEffect(() => {
    if (idx >= candidates.length) onExhausted?.();
    // 候选数组随 url/mode 变化，length 是充分的稳定信号
  }, [idx, candidates.length, onExhausted]);

  const src = candidates[idx];

  /**
   * 缓存命中的图片可能在 React 挂载监听之前就已是 complete 状态，原生 load 事件
   * 不会再补发——只靠 onLoad 会让等待方永远以为没加载好。这里按 src 同步补查一次：
   * 已成功则补发 onLoad，已失败则直接推进候选链。
   */
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !el.complete) return;
    if (el.naturalWidth > 0) onLoadRef.current?.();
    // SVG 可以合法地没有固有尺寸（naturalWidth 0），不能按坏图推进候选链
    else if (!/\.svg(?:[?#]|$)/i.test(src ?? '')) setIdx((i) => i + 1);
  }, [src]);

  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      referrerPolicy="no-referrer"
      onLoad={() => onLoadRef.current?.()}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}
