/**
 * 浏览器标题栏 / 状态栏取色（`<meta name="theme-color">`）。
 *
 * 站点主题是**手动两态**（`html.dark`），和 `prefers-color-scheme` 无关，
 * 所以不能用「两条带 media 的 meta」——那样切主题时浏览器读到的仍是系统偏好。
 * 只能保留一条 meta，在切主题时改它的 content：
 * - 首屏：layout 的 head 内联脚本（由 themeBootstrapScript 生成）同步改。必须同步，
 *   否则浅色用户会先看到一帧深色地址栏；
 * - 运行期：ThemeProvider 的 apply() 调 applyThemeColor()。
 *
 * 取色用**页面底色**：iOS 的越界回弹区也用 theme-color，取顶栏色会和页面露出的底色打架。
 * 能生效的只有移动端浏览器（Android Chrome 地址栏/状态栏、iOS Safari 状态栏/标签栏/回弹区、
 * macOS Safari 紧凑标签栏）；桌面普通标签页的标题栏由操作系统绘制，没有 Web API。
 */

export type ThemeChoice = 'light' | 'dark';

/** 与 globals.css 的 --c-page 对齐（亮 #f6f7f9 / 暗 #0b101a） */
export const THEME_COLORS: Record<ThemeChoice, string> = {
  light: '#f6f7f9',
  dark: '#0b101a',
};

export const THEME_STORAGE_KEY = 'libretv-theme';
export const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';

export function themeColorOf(theme: ThemeChoice): string {
  return THEME_COLORS[theme];
}

/** 运行期同步 meta。找不到就补一条：layout 手写过一条，这里只是兜底（例如被扩展/脚本摘掉） */
export function applyThemeColor(theme: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  let meta = document.querySelector<HTMLMetaElement>(THEME_COLOR_SELECTOR);
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', themeColorOf(theme));
}

/**
 * 首屏内联脚本：读主题 → 切 .dark → 同步 theme-color。
 * 颜色与 storage key 都从上面的常量注入，避免脚本字符串和 TS 两处硬编码走散。
 * 保持 ES5 语法与整段 try/catch：这是 <head> 里、任何 polyfill 之前执行的代码。
 */
export function themeBootstrapScript(): string {
  const key = THEME_STORAGE_KEY;
  const { light, dark } = THEME_COLORS;
  return (
    '(function(){try{' +
    `var k=${JSON.stringify(key)},d=${JSON.stringify(dark)},l=${JSON.stringify(light)};` +
    'var t=localStorage.getItem(k);' +
    "if(t!=='light'&&t!=='dark'){t='dark';localStorage.setItem(k,t);}" +
    "document.documentElement.classList.toggle('dark',t==='dark');" +
    `var m=document.querySelector(${JSON.stringify(THEME_COLOR_SELECTOR)});` +
    "if(m)m.setAttribute('content',t==='dark'?d:l);" +
    '}catch(e){}})()'
  );
}
