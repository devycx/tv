import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_COLORS,
  THEME_COLOR_SELECTOR,
  THEME_STORAGE_KEY,
  applyThemeColor,
  themeBootstrapScript,
  themeColorOf,
} from './theme-color';

/**
 * 驱动真正的 themeBootstrapScript() / applyThemeColor()，替身只记录 DOM 写入。
 * 盯的是两件会静默失效的事：
 * 1) 首屏脚本改了 .dark 但忘了改 theme-color（浅色主题下手机地址栏还是深色）；
 * 2) 存量 'system' 规范化后 meta 没跟着落成 dark。
 */

interface DocStub {
  documentElement: { classList: { toggle: (token: string, on: boolean) => void } };
  querySelector: (selector: string) => { setAttribute: (name: string, value: string) => void } | null;
  createElement: () => { setAttribute: (name: string, value: string) => void };
  head: { appendChild: () => void };
}

function fakeDocument(hasMeta = true) {
  const classes = new Set<string>();
  const created: Array<{ attrs: Map<string, string> }> = [];
  const metaAttrs = new Map<string, string>();
  const meta = { setAttribute: (name: string, value: string) => metaAttrs.set(name, value) };
  const doc: DocStub = {
    documentElement: {
      classList: {
        toggle: (token, on) => (on ? classes.add(token) : classes.delete(token)),
      },
    },
    querySelector: (selector) => (hasMeta && selector === THEME_COLOR_SELECTOR ? meta : null),
    createElement: () => {
      const el = { attrs: new Map<string, string>() };
      created.push(el);
      return { setAttribute: (name: string, value: string) => el.attrs.set(name, value) };
    },
    head: { appendChild: () => {} },
  };
  return { doc, classes, metaAttrs, created };
}

function runBootstrap(stored: string | null) {
  const { doc, classes, metaAttrs } = fakeDocument();
  const writes: Array<[string, string]> = [];
  const storage = {
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null),
    setItem: (key: string, value: string) => {
      writes.push([key, value]);
    },
  };
  new Function('document', 'localStorage', themeBootstrapScript())(doc, storage);
  return { dark: classes.has('dark'), content: metaAttrs.get('content'), writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('themeColorOf', () => {
  it('两态各自对应页面底色', () => {
    expect(themeColorOf('light')).toBe('#f6f7f9');
    expect(themeColorOf('dark')).toBe('#0b101a');
    expect(THEME_COLORS.light).toBe('#f6f7f9');
  });
});

describe('themeBootstrapScript', () => {
  it('深色主题：挂 .dark 并把 meta 写成页面深色底', () => {
    const { dark, content } = runBootstrap('dark');
    expect(dark).toBe(true);
    expect(content).toBe(THEME_COLORS.dark);
  });

  it('浅色主题：不挂 .dark，meta 同步成浅色底（回归点）', () => {
    const { dark, content } = runBootstrap('light');
    expect(dark).toBe(false);
    expect(content).toBe(THEME_COLORS.light);
  });

  it('存量 system / 空值一律规范化为 dark 并就地写回', () => {
    const { dark, content, writes } = runBootstrap('system');
    expect(dark).toBe(true);
    expect(content).toBe(THEME_COLORS.dark);
    expect(writes).toEqual([[THEME_STORAGE_KEY, 'dark']]);
  });

  it('脚本里出现的是真实常量，不是再抄一份 hex', () => {
    const script = themeBootstrapScript();
    expect(script).toContain(THEME_COLORS.dark);
    expect(script).toContain(THEME_COLORS.light);
    expect(script).toContain(THEME_STORAGE_KEY);
  });
});

describe('applyThemeColor', () => {
  it('运行期切换改写已有 meta', () => {
    const { doc, metaAttrs } = fakeDocument();
    vi.stubGlobal('document', doc);
    applyThemeColor('light');
    expect(metaAttrs.get('content')).toBe(THEME_COLORS.light);
    applyThemeColor('dark');
    expect(metaAttrs.get('content')).toBe(THEME_COLORS.dark);
  });

  it('meta 被摘掉时补一条（不静默失效）', () => {
    const { doc, created, metaAttrs } = fakeDocument(false);
    vi.stubGlobal('document', doc);
    applyThemeColor('light');
    expect(created).toHaveLength(1);
    expect(created[0].attrs.get('name')).toBe('theme-color');
    expect(created[0].attrs.get('content')).toBe(THEME_COLORS.light);
    // 已有 meta 的路径不应被触发
    expect(metaAttrs.size).toBe(0);
  });
});
