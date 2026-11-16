'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaArtwork } from '@/lib/media-session';
import { cropToSquareBlob } from '@/lib/square-artwork';

/**
 * 通知栏封面：把页面给的封面裁成 1:1 方图（见 lib/square-artwork.ts）。
 *
 * 返回值的语义：
 * - 合成中 / 合成失败 / 已经是方图 → 原样返回入参，通知栏至少还有图（矩形）；
 * - 合成成功 → 换成 512×512 的 blob URL，系统按正方形展示，不再出现「完整矩形海报」。
 *
 * blob URL 的生命周期跟着封面走：换集时旧 URL 先留着（新图还没好之前继续能显示），
 * 新的合成成功后再回收旧的；组件卸载时回收最后一个。
 */
export function useSquareArtwork(artwork?: MediaArtwork): MediaArtwork | undefined {
  const [square, setSquare] = useState<MediaArtwork | undefined>(undefined);
  const blobUrlRef = useRef<string | null>(null);
  const src = artwork?.src;

  useEffect(() => {
    setSquare(undefined);
    if (!src) return;
    let cancelled = false;
    cropToSquareBlob(src)
      .then((result) => {
        if (cancelled || !result) return;
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = result.url;
        setSquare({
          src: result.url,
          sizes: `${result.size}x${result.size}`,
          type: result.type,
        });
      })
      .catch(() => {
        /* 回退原图，不打断播放 */
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(
    () => () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    },
    []
  );

  return square ?? artwork;
}
