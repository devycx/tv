import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import generatedBootstrap from '@/lib/bootstrap.generated.json';
import type { BootstrapConfig } from '@/lib/bootstrap';

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
    default: '夜幕影视 - 私人影视聚合',
    template: '%s - 夜幕影视',
  },
  description:
    '夜幕影视 是一个私人影视聚合平台：汇聚多个公开点播源与直播源，提供搜索、播放、收藏与观看记录，仅供个人学习使用。',
  manifest: '/manifest.webmanifest',
  // 页面/标签页图标用**透明背景**的徽标（YouTube 风格）：深色底的 icon-*.png 只留给
  // manifest 里的 PWA 安装图标。此前把深色底 PNG 声明为页面 icon，浏览器的标签页/书签
  // 会显示成一个黑底方块；透明徽标 contain 到正方形后会水平铺满、上下留透明边。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/favicon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0b101a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('libretv-theme')||'dark';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})()",
          }}
        />
      </head>
      <body>
        <Providers bootstrap={bootstrap}>{children}</Providers>
      </body>
    </html>
  );
}
