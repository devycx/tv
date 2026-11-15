'use client';

import { cn } from '@/lib/utils';
import { describeQualityBadge } from '@/lib/quality';
import type { QualityEntry } from '@/lib/types';

/**
 * 画质徽章：只在真的探到分辨率时出现。
 *
 * 「未探到」「探测中」「源站没给画质」都不渲染——搜索列表里一屏十几个「未测到」
 * 既没有信息量，也会把用户真正要看的「1080P / 720P」淹掉。探测仍在后台进行，
 * 结果回来时徽章自己出现；失败重试由全局探测队列负责，不需要每行一个重试按钮。
 */
export function QualityBadge({ entry, className }: { entry?: QualityEntry; className?: string }) {
  const view = describeQualityBadge(entry, false);
  if (!view || view.kind !== 'value') return null;

  const height = entry?.height ?? 0;
  return (
    <span
      className={cn(
        'tag font-medium shrink-0',
        // 高画质给强调色；≤480 的标清退到 faint，让它在「源名 / 画质 / 集数」里自然后置
        height >= 1080 ? 'bg-accent/15 text-accent' : height > 0 && height < 480 ? 'bg-chip text-faint' : 'bg-chip text-muted',
        className
      )}
      title={view.title}
    >
      {view.label}
    </span>
  );
}
