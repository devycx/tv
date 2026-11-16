'use client';

import { useEffect } from 'react';
import { shouldApplyDocumentTitle } from '@/lib/document-title';
import { DEFAULT_DOCUMENT_TITLE } from '@/lib/site';

/**
 * 播放页 / 直播页把窗口标题换成正在播的内容（标签页、任务栏、PiP 窗口标题）。
 *
 * 两个坑决定了这里必须「写完再盯着」：
 *
 * 1. **生产构建里 React 会重建 head 里的 `<title>`**。Next 15 把根布局的 metadata
 *    随 RSC 流在页面内容之后送达，hydration 时 React 新建一个默认标题的 `<title>`，
 *    把我们在 effect 里写的标题覆盖回默认值（本地 `next dev` 不流式，所以看不出来）。
 *    因此挂一个只读 MutationObserver：标题被重置回默认值就补写一次，直到卸载。
 * 2. **React 不会因为 `document.title` 被手动改过就回写**（它只比较虚拟文本），
 *    所以离开播放页时必须自己把标题还原，否则标签页一直挂着上一部片名。
 *
 * 为不抢别的路由：补写只在当前标题仍是「默认标题」时进行；别的路由写了自己的标题
 * 就停手（本项目目前所有页面都是默认标题，这条是给以后加 metadata 的页面留的）。
 */
export function useDocumentTitle(title: string | undefined | null): void {
  useEffect(() => {
    if (!title) return;
    let appliable = true;

    const apply = () => {
      if (!appliable) return;
      // 只补写「被重置回默认/空」的场景，不跟别的页面的标题抢
      if (!shouldApplyDocumentTitle(document.title, title, DEFAULT_DOCUMENT_TITLE)) return;
      document.title = title;
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    return () => {
      appliable = false;
      observer.disconnect();
      // 只在「当前标题仍是我们的」时还原，避免踩掉下一条路由刚设好的标题
      if (document.title === title) document.title = DEFAULT_DOCUMENT_TITLE;
    };
  }, [title]);
}
