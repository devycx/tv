/**
 * 通知栏封面裁成 1:1。
 *
 * 背景（2026-11-16 用户真机反馈）：Android 媒体通知按素材**原始比例**展示封面，
 * 给竖版海报（如豆瓣 540×800）就出来一个矩形，不会自己居中裁方。要 1:1 只能自己裁：
 * canvas 取中间最大正方形 → 缩到 ≤512（Chrome Android 通知封面标准尺寸 512×512）
 * → `canvas.toBlob` 得到同源 blob URL 交给 MediaMetadata（官方文档明确支持 blob / data URL）。
 *
 * 失败（图站不给 CORS、图片解码失败、超时）一律返回 null，调用方退回原图 —— 宁可保持矩形，
 * 也不能因为合成失败让通知栏没封面。
 */

export interface SquareCrop {
  /** 源图上的裁切起点（像素） */
  sx: number;
  sy: number;
  /** 源图上的裁切边长 */
  source: number;
  /** 输出画布边长：不超过 maxSide，也不放大 */
  output: number;
}

/** 中间最大正方形；output 取 min(maxSide, 源短边)，不放大低分辨率封面 */
export function centerSquareCrop(width: number, height: number, maxSide = 512): SquareCrop {
  const source = Math.max(1, Math.min(width, height));
  return {
    sx: Math.round((width - source) / 2),
    sy: Math.round((height - source) / 2),
    source,
    output: Math.min(maxSide, source),
  };
}

/** 已经接近正方形就不折腾：直接复用原图，避免把台标/方图重新编码一遍 */
export function isNearlySquare(width: number, height: number, tolerance = 0.02): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width - height) <= Math.max(width, height) * tolerance;
}

const LOAD_TIMEOUT_MS = 5000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 与 <img referrerPolicy="no-referrer"> 一致：豆瓣镜像不需要 Referer，原站空 Referer 会 418
    img.referrerPolicy = 'no-referrer';
    // 必须带 CORS 才敢 drawImage，否则 canvas 被污染、toBlob 抛 SecurityError
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('artwork load timeout')), LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('artwork load failed'));
    };
    img.src = src;
  });
}

export interface SquareArtworkResult {
  url: string;
  size: number;
  type: string;
}

/**
 * 把封面裁成 1:1 的 blob URL。返回 null 表示「不做/做不了」，调用方继续用原图。
 */
export async function cropToSquareBlob(
  src: string,
  options: { maxSide?: number } = {}
): Promise<SquareArtworkResult | null> {
  if (typeof document === 'undefined') return null;
  const maxSide = options.maxSide ?? 512;
  try {
    const img = await loadImage(src);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    // 已经是方图（台标、方版海报）：原样用，别重新编码出糊图
    if (isNearlySquare(width, height)) return null;

    const crop = centerSquareCrop(width, height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = crop.output;
    canvas.height = crop.output;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      crop.sx,
      crop.sy,
      crop.source,
      crop.source,
      0,
      0,
      crop.output,
      crop.output
    );

    // PNG/WebP 可能带透明，保持无损；照片类封面用 JPEG 压到 ~几十 KB
    const type = /\.(png|webp)(?:$|[?#])/i.test(src) ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, 0.9)
    );
    if (!blob) return null;
    return { url: URL.createObjectURL(blob), size: crop.output, type };
  } catch {
    // CORS 污染 / 解码失败 / 超时：交给调用方回退原图
    return null;
  }
}
