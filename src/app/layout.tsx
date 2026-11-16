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
  // 这里只声明**一条内联 data URI**（48px，由 `npm run icons` 生成到
  // lib/favicon.generated.json），故意不再挂 /favicon.ico、favicon-*.png 的 link：
  // - 手机浏览器首访要先请求 favicon，请求回来之前标签页会先画一个深色占位方块，
  //   表现为「首次访问黑底、刷新后透明」（刷新时图标已在缓存里）。data URI 随 HTML
  //   一起到达，解析时就有图标，Chrome 实测不再发任何图标请求。
  // - 一旦再挂网络图标 link，浏览器会按尺寸挑更大的那张去下载，首访黑方块就又回来了。
  // 不认 data URI 的老浏览器仍会隐式请求根目录 /favicon.ico（同一份透明徽标）兜底。
  icons: {
    icon: [
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
