'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { safeNextPath } from '@/lib/safe-next';

/**
 * 登录页（/login）。
 *
 * 未认证访问任何页面时 middleware 会 302 到这里（`?next=<原始路径+query>`）。
 * 这里不依赖首页那套 AuthProvider 登录弹窗：页面被 middleware 拦下时，
 * 首页根本不会渲染，弹窗自然也不会出现。
 *
 * 读取 `next` 用 window.location 而不是 useSearchParams：
 * 后者会把本页变成需要 Suspense 的动态边界，静态预渲染的 HTML 里就只剩 fallback
 * （验证时要求 `/login` 的 HTML 直接含密码输入框）。
 */

export default function LoginPage() {
  const [next, setNext] = useState('/');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const target = safeNextPath(new URLSearchParams(window.location.search).get('next'));
    setNext(target);
    inputRef.current?.focus();

    // 已是登录态（比如会话未过期时直接打开 /login；middleware 正常时不会走到这里）直接回跳
    let cancelled = false;
    fetch('/api/auth', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ verified?: boolean }>) : null))
      .then((data) => {
        if (!cancelled && data?.verified) window.location.replace(target);
      })
      .catch(() => {
        // 查询会话状态失败不阻塞手输密码
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = password.trim();
    if (!value || loading) return;

    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value }),
      });
      if (res.ok) {
        // replace 而非 assign：登录页不进历史栈，回退不会又回到登录页
        window.location.replace(next);
        return;
      }

      let message = res.status === 401 ? '密码错误' : `验证失败（${res.status}）`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data?.error) message = res.status === 401 ? '密码错误' : data.error;
      } catch {
        // 非 JSON 响应时用状态码兜底
      }
      setError(message);
      setPassword('');
      inputRef.current?.focus();
    } catch {
      setError('网络请求失败，请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-512.png" alt="夜幕TV" className="w-14 h-14 rounded-2xl shadow-lg" />
          <h1 className="mt-3 text-2xl font-bold brand-gradient">夜幕TV</h1>
          <p className="mt-1.5 text-sm text-muted">请输入访问密码以继续</p>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-3">
          <label htmlFor="login-password" className="block text-sm font-medium text-content">
            访问密码
          </label>
          <input
            ref={inputRef}
            id="login-password"
            type="password"
            className="input w-full"
            placeholder="密码"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError('');
            }}
            maxLength={128}
            autoComplete="current-password"
            autoFocus
            disabled={loading}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
          />
          {error && (
            <p id="login-error" role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full mt-1" disabled={loading || !password.trim()}>
            {loading ? '验证中...' : '进入'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-faint">登录状态会保存在本机浏览器，有效期 90 天</p>
      </div>
    </main>
  );
}
