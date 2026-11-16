import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import generatedBootstrap from '@/lib/bootstrap.generated.json';
import generatedFavicon from '@/lib/favicon.generated.json';
import type { BootstrapConfig } from '@/lib/bootstrap';
import { THEME_COLORS, themeBootstrapScript } from '@/lib/theme-color';
import { DEFAULT_DOCUMENT_TITLE, TITLE_TEMPLATE } from '@/lib/site';

/**
 * 首屏 bootstrap 在**构建期**由 scripts/gen-wrangler.mjs 从同一份源列表生成并写进
 * src/lib/bootstrap.generated.json，静态预渲染时内联进 HTML。
 *
 * 不能改成在请求期读 process.env：那会让根 layout 变成动态渲染（connection()），
 * 实测页面 CPU 从 ~20ms 涨到 300ms+，直接撞免费版 10ms CPU 配额。
 */
const bootstrap = generatedBootstrap as BootstrapConfig;

export const metadata: Metadata = {
  title: {
    default: DEFAULT_DOCUMENT_TITLE,
    template: TITLE_TEMPLATE,
  },
  description:
    '夜幕影视 是一个私人影视聚合平台：汇聚多个公开点播源与直播源，提供搜索、播放、收藏与观看记录，仅供个人学习使用。',
  manifest: '/manifest.webmanifest',
  // 标签页图标是**透明徽标**（YouTube 风格）：深色底的 icon-*.png 只留给 manifest 里的
  // PWA 安装图标。此前把深色底 PNG 声明为页面 icon，标签页/书签会显示成一个黑底方块。
  //
  // 两条来源，缺一不可（2026-11-16 两次线上回归换来的结论）：
  // - **网络图标（主路径）**：`?v=` 用图标内容的短哈希（`npm run icons` 生成到
  //   lib/favicon.generated.json）。手机端 Chromium 变种里有的不认 data URI，只认网络图标；
  //   而且浏览器图标库对同一 URL 的图标缓存很久，换 logo 不换 URL 就会一直显示旧图
  //   （典型症状：手机标签页一直是深色底方块，刷新也不变）。URL 带版本号后必被重拉。
  // - **内联 data URI（兜底）**：支持它的实现能做到「解析 HTML 即可有图标」。但实测
  //   Chromium 只要看到网络图标就会优先用网络图标，所以别把它当主路径——只声明 data URI
  //   时，不认它的浏览器会退回图标库里缓存的旧图（这就是 11-16 上午那次回归）。
  icons: {
    icon: [
      { url: `/favicon.ico?v=${generatedFavicon.version}`, sizes: '16x16 32x32 48x48' },
      { url: `/icons/favicon-32.png?v=${generatedFavicon.version}`, sizes: '32x32', type: 'image/png' },
      { url: `/icons/favicon-96.png?v=${generatedFavicon.version}`, sizes: '96x96', type: 'image/png' },
      {
        url: generatedFavicon.dataUri,
        sizes: `${generatedFavicon.size}x${generatedFavicon.size}`,
        type: generatedFavicon.type,
      },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

/**
 * 主题色**不放在这里**：viewport 的 themeColor 是构建期死值，切主题时没人改它，
 * 浅色主题下手机地址栏/状态栏会一直是深色。改由 head 里手写一条 meta，
 * 首屏内联脚本与 ThemeProvider 负责改 content（见 lib/theme-color.ts）。
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 主题色：手写一条（不用 viewport 的 themeColor，见上面注释），内容由脚本改写 */}
        <meta name="theme-color" content={THEME_COLORS.dark} />
        {/* 首屏前同步主题，避免亮暗闪烁，顺带把 theme-color 校准 */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
      </head>
      <body>
        <Providers bootstrap={bootstrap}>{children}</Providers>
      </body>
    </html>
  );
}
