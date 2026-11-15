'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * 多行文本 + 「展开 / 收起」。
 *
 * 两个约束：
 * 1. 只有真的被截断时才显示按钮——短简介下面挂个「展开」是噪音；
 * 2. 换片（text 变化）要回到收起态，否则上一部展开着，点开下一部直接是长文本。
 *
 * 溢出判定靠 `scrollHeight > clientHeight`：clamp 用的是 `-webkit-line-clamp` +
 * `overflow: hidden`，Chromium 下 scrollHeight 仍是完整内容高度。窄屏/旋转导致换行变化时
 * 用 ResizeObserver 重新量。
 */
export function ExpandableText({
  text,
  clampClass = 'line-clamp-3',
  className,
}: {
  text: string;
  /** 收起态的行数截断类名（默认 3 行；类定义在 globals.css） */
  clampClass?: string;
  className?: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    // 展开态量不出「是否被截断」（clientHeight == scrollHeight），保留上一次结论
    if (expanded) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded, measure]);

  return (
    <div className={className}>
      <p
        id={id}
        ref={ref}
        className={cn('text-sm text-muted leading-relaxed whitespace-pre-line break-words', !expanded && clampClass)}
      >
        {text}
      </p>
      {(overflowing || expanded) && (
        <button
          type="button"
          className="mt-1 inline-flex items-center gap-0.5 text-xs text-accent hover:text-accent-hover transition-colors"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : '展开'}
          <Icon name="chevronDown" className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}
