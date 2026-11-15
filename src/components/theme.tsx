'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 主题上下文：只有 light / dark 两态（2026-11-15 用户要求去掉「跟随系统」），
 * 持久化到 localStorage，默认 dark。html 上的 .dark 类由 layout 中的内联脚本先行设置
 * （避免首屏闪烁），此处负责后续切换。
 */

export type ThemeChoice = 'light' | 'dark';
const STORAGE_KEY = 'libretv-theme';

interface ThemeContextValue {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  setTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** 存量数据里可能有旧的 'system'（三态时代）：统一落回 dark，不再跟随系统 */
function normalize(value: string | null): ThemeChoice {
  return value === 'light' ? 'light' : 'dark';
}

function apply(choice: ThemeChoice): void {
  document.documentElement.classList.toggle('dark', choice === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>('dark');

  useEffect(() => {
    const stored = normalize(localStorage.getItem(STORAGE_KEY));
    setThemeState(stored);
    apply(stored);
    // 旧值（'system' 等）就地规范化：下次首屏内联脚本就不用再处理跟随系统
    localStorage.setItem(STORAGE_KEY, stored);
  }, []);

  const setTheme = useCallback((t: ThemeChoice) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
    apply(t);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

/** 亮暗切换按钮：light ⇄ dark 两态 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next: ThemeChoice = theme === 'dark' ? 'light' : 'dark';
  const label = theme === 'dark' ? '深色' : '浅色';
  const nextLabel = next === 'dark' ? '深色' : '浅色';

  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={`主题：${label}，点击切换为${nextLabel}`}
      aria-label={`切换主题，当前 ${label}`}
      onClick={() => setTheme(next)}
    >
      {theme === 'dark' ? (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ) : (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      )}
    </button>
  );
}
