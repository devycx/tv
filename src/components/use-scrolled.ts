'use client';

import { useEffect, useState } from 'react';

/**
 * 页面是否已滚动过阈值。
 *
 * 顶栏按需求去掉了硬边框（静止态与页面之间无框线），滚动时再用一层极淡阴影
 * 表达「内容从下面穿过」——静止时无痕、滚动时有分离感，比常驻 border 干净。
 */
export function useScrolled(threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);

  return scrolled;
}
