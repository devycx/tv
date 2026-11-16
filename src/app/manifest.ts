import type { MetadataRoute } from 'next';
import { DEFAULT_DOCUMENT_TITLE, SITE_NAME } from '@/lib/site';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: DEFAULT_DOCUMENT_TITLE,
    short_name: SITE_NAME,
    description: '私人影视聚合平台，汇聚公开点播源与直播源',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b101a',
    theme_color: '#0b101a',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
