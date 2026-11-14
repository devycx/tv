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
    default: '夜幕TV - 私人影视聚合',
    template: '%s - 夜幕TV',
  },
  description:
    '夜幕TV 是一个私人影视聚合平台：汇聚多个公开点播源与直播源，提供搜索、播放、收藏与观看记录，仅供个人学习使用。',
  manifest: '/manifest.webmanifest',
  // 同一张品牌 artwork（由 Gemini 设计）导出的多尺寸 PNG + 根目录 favicon.ico 兜底。
  // 只声明单张 512 时，抓取端只能拿大图缩放，小尺寸下易糊、看起来「没填满」。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
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
