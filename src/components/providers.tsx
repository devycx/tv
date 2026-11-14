'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ToastProvider } from './toast';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';
import { GlobalDownloadManager } from './download-manager';
import { useAppStore, hydrateLiveProbeResults } from '@/lib/store';
import { applyEnvPresets } from '@/lib/subscription-sync';
import type { BootstrapConfig } from '@/lib/bootstrap';

export function Providers({
  children,
  bootstrap,
}: {
  children: ReactNode;
  /** 根 layout 在服务端读出的首屏配置（已内联进 HTML，页面加载不再请求 /api/status） */
  bootstrap: BootstrapConfig;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 },
        },
      })
  );

  // /login 是唯一「确定未登录」的路由（middleware 只把未认证请求放在这里）。
  // 登录页同样渲染 Providers，不能按「已登录」去跑需要鉴权的自动刷新。
  const pathname = usePathname();
  const initialVerified = pathname !== '/login';

  // bootstrap 来自根 layout，会话内不变；用 ref 固定首屏值，避免 router.refresh() 重新
  // 下发 layout 时重复 rehydrate（会用持久化快照覆盖内存里的最新状态）与重复应用预置。
  const bootstrapRef = useRef(bootstrap);
  const verifiedRef = useRef(initialVerified);

  // store 配置了 skipHydration：等挂载后再读 localStorage，
  // 保证 hydration 阶段客户端与服务端渲染结果一致。
  useEffect(() => {
    // 先等持久化状态恢复，再应用服务端内联的预置数据：
    // 避免 setEnvSources/setLiveEnvSources 的勾选合并发生在 rehydrate 之前被覆盖
    Promise.resolve(useAppStore.persist.rehydrate())
      .then(() => {
        // 测活缓存从 IndexedDB 恢复（并顺带搬迁旧 localStorage 快照里的存量），失败静默
        void hydrateLiveProbeResults();
        // 预置数据（DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES / DEFAULT_SUBSCRIPTIONS）
        // 由首屏 bootstrap 下发，不再请求 /api/status；预置订阅要经鉴权接口拉取，
        // 登录页这次会 401 静默失败，登录成功后由 AuthProvider 用同一份 bootstrap 补跑（幂等）
        return applyEnvPresets(bootstrapRef.current, { verified: verifiedRef.current });
      })
      .catch(() => {});
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          {/* 全站常驻：下载事件监听（enqueueDownload）依赖它存在——
              挂在 Header 里会让 /watch 等不渲染 Header 的页面派发的事件凭空丢失 */}
          <GlobalDownloadManager />
          <AuthProvider bootstrap={bootstrap} initialVerified={initialVerified}>
            {children}
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
