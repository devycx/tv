'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized } from '@/lib/client-api';
import { applyEnvPresets } from '@/lib/subscription-sync';
import type { BootstrapConfig } from '@/lib/bootstrap';
import { useToast } from './toast';

/**
 * 认证上下文：
 * - 首屏不再查询 /api/status：能渲染受保护页面即已登录（middleware 保证），
 *   版本 / 是否配置 PASSWORD / 预置源等静态配置由根 layout 通过 bootstrap 内联下发；
 * - 任何 API 返回 401/503 时全局打开登录框（客户端 API 层统一触发，不再散落检查）。
 */

type SetupRequired = boolean;

interface AuthContextValue {
  /** 首屏即完成「校验」（bootstrap 是同步下发的），保留字段兼容既有调用方 */
  checked: boolean;
  verified: boolean;
  /** 服务器未设置 PASSWORD，需要管理员配置 */
  setupRequired: SetupRequired;
  /** 应用版本（构建时从 package.json 注入，经首屏 bootstrap 下发） */
  version: string | null;
  openLogin: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  checked: true,
  verified: false,
  setupRequired: false,
  version: null,
  openLogin: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({
  children,
  bootstrap,
  initialVerified = true,
}: {
  children: ReactNode;
  /** 根 layout 内联的首屏配置（版本、passwordRequired、预置源等） */
  bootstrap: BootstrapConfig;
  /**
   * 首屏是否已登录：受保护页面能渲染即已登录；/login 由 Providers 传 false。
   * 同步可用，不再等 /api/status 返回（live/watch 不会先闪「等待访问验证」）。
   */
  initialVerified?: boolean;
}) {
  const [verified, setVerified] = useState(initialVerified);
  const [setupRequired, setSetupRequired] = useState(!bootstrap.passwordRequired);
  const [modalOpen, setModalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      onUnauthorized((event) => {
        const setup = (event as CustomEvent).detail === 'setup';
        setSetupRequired(setup);
        setVerified(false);
        // /login 页自己就是密码入口：再叠一层弹窗会挡住输入框
        // （middleware 拦截后首屏会落在 /login，此时任何 401 都不该弹窗）
        const onLoginPage = window.location.pathname === '/login' || window.location.pathname === '/login/';
        if (!onLoginPage) setModalOpen(true);
      }),
    []
  );

  const openLogin = useCallback(() => setModalOpen(true), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setVerified(false);
      toast('已退出登录', 'info');
    }
  }, [toast]);

  const handleLoginSuccess = useCallback(async () => {
    setVerified(true);
    setSetupRequired(false);
    setModalOpen(false);
    // 登录前以 401 失败的查询（如豆瓣推荐）需要重新拉取
    queryClient.invalidateQueries();
    toast('验证成功', 'success');
    // 预置订阅 / 用户订阅自动刷新要经鉴权接口：登录前那次 401 静默失败，
    // 这里用首屏同一份 bootstrap 补跑一次（applyEnvPresets 幂等），不再补拉 status
    try {
      await applyEnvPresets(bootstrap, { verified: true });
    } catch {
      // 补跑预置数据失败不影响登录后的正常使用
    }
  }, [toast, queryClient, bootstrap]);

  // bootstrap 同步下发，没有异步「校验中」阶段
  const checked = true;

  return (
    <AuthContext.Provider
      value={{ checked, verified, setupRequired, version: bootstrap.version, openLogin, logout }}
    >
      {children}
      {modalOpen && (
        <LoginModal
          setupRequired={setupRequired}
          onSuccess={handleLoginSuccess}
          onClose={() => setModalOpen(false)}
        />
      )}
    </AuthContext.Provider>
  );
}

function LoginModal({
  setupRequired,
  onSuccess,
  onClose,
}: {
  setupRequired: boolean;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const submit = async () => {
    if (!password.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '验证失败';
      setError(msg === '需要登录' ? '密码错误' : msg);
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-surface-raised rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={setupRequired ? '需要配置密码' : '访问验证'}
      >
        {setupRequired ? (
          <>
            <h2 className="text-lg font-semibold text-content mb-3">需要配置密码</h2>
            <p className="text-sm text-muted leading-relaxed">
              请在部署配置中设置 <code className="text-accent">PASSWORD</code> 环境变量后重启服务。
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-content mb-3">访问验证</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
                placeholder="密码"
                autoComplete="current-password"
              />
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
              <button type="submit" className="btn-primary w-full mt-4" disabled={loading || !password.trim()}>
                {loading ? '验证中...' : '进入'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
