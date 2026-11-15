/**
 * 封面视觉指纹（纯函数，便于单测）。
 *
 * 采集站的封面经常是同一张图的不同副本：换域名、换文件名、换分辨率/压缩率。
 * 只按 URL 分组会把它们拆开；这里用 dHash（9×8 灰度差分哈希）把「看起来一样」的
 * 封面归到同一个 64 位指纹，再按汉明距离聚类。
 *
 * dHash 的性质：
 * - 同一张图缩放/重新压缩后，指纹通常只差几位（实测同海报 270×371 与 350×477 差 7 位）；
 * - 不同海报/不同影片通常差 30 位以上（实测《色，戒》两种海报差 35 位）。
 * 因此阈值取 10：能合并同图的不同副本，又不会把不同影片并到一起。
 *
 * 画到 9×8 之前先按 COVER_HASH_ASPECT（4:5）中心裁切：整图拉伸会把「2:3 海报 vs
 * 9:16 带台标/赞助条的同一主视觉」算成两张图（实测距离 19–21），裁切后为 4。
 *
 * 浏览器把封面画到 9×8 canvas 后调用 dHashFromRgba；服务端/测试可直接用
 * dHashFromLuma 构造已知亮度的 72 个像素。
 */

/** 两个封面指纹允许的最大汉明距离（64 位里不同位的个数） */
export const COVER_HASH_MAX_DISTANCE = 10;

/**
 * 指纹取景画幅（宽 / 高 = 4:5）。
 *
 * 只把整张图拉伸到 9×8 会把「画幅差异」也算成视觉差异：同一张主视觉，
 * 采集站常见 2:3 海报和 9:16（带顶部台标条、底部赞助/扫码区）两种裁切，
 * 实测整图 dHash 距离 19–21，超过阈值 10，于是同一部片被拆成两张卡。
 *
 * 先按中心裁成统一画幅再缩放，两边只比较共同的中心区域：
 * 实测同一主视觉的 2:3 / 9:16 距离降到 4，而不同影片/不同海报仍在 27 以上。
 */
export const COVER_HASH_ASPECT = 4 / 5;

const HASH_HEX = /^[0-9a-f]{16}$/;

/**
 * 中心裁切矩形：把 width×height 的封面裁成 COVER_HASH_ASPECT（宽/高）的画幅。
 * 返回 dHash 画布 drawImage 需要的 source 矩形；返回浮点值由调用方取整。
 */
export function coverCropRect(
  width: number,
  height: number
): { sx: number; sy: number; sw: number; sh: number } {
  if (!(width > 0) || !(height > 0)) return { sx: 0, sy: 0, sw: width, sh: height };
  const targetHeight = width / COVER_HASH_ASPECT;
  if (targetHeight <= height) {
    return { sx: 0, sy: (height - targetHeight) / 2, sw: width, sh: targetHeight };
  }
  const targetWidth = height * COVER_HASH_ASPECT;
  return { sx: (width - targetWidth) / 2, sy: 0, sw: targetWidth, sh: height };
}

/** 9×8 灰度亮度 → 64 位 dHash（16 位十六进制字符串） */
export function dHashFromLuma(luma: readonly number[]): string {
  if (luma.length !== 9 * 8) throw new Error('dHash 需要 9×8=72 个亮度值');
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      // 从左到右比较相邻像素：左边更暗记 1
      bits += luma[y * 9 + x] < luma[y * 9 + x + 1] ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

/** RGBA 像素（9×8×4）→ dHash；亮度按 ITU-R BT.601 */
export function dHashFromRgba(rgba: Uint8ClampedArray): string {
  if (rgba.length !== 9 * 8 * 4) throw new Error('dHash 需要 9×8 的 RGBA 像素');
  const luma: number[] = new Array(9 * 8);
  for (let i = 0; i < 9 * 8; i++) {
    const p = i * 4;
    luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return dHashFromLuma(luma);
}

/** 两个 dHash 的汉明距离；非法指纹返回 Infinity（不参与聚类） */
export function hammingDistance(a: string, b: string): number {
  if (!HASH_HEX.test(a) || !HASH_HEX.test(b)) return Infinity;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * 按汉明距离把指纹聚类（并查集，传递闭包）。
 * 返回「指纹 → 簇代表」映射；簇代表取簇内字典序最小的指纹，
 * 保证同一组封面在流式追加/重排时得到稳定的 key。
 */
export function clusterCoverHashes(
  hashes: Iterable<string>,
  maxDistance = COVER_HASH_MAX_DISTANCE
): Map<string, string> {
  const unique = [...new Set(hashes)].filter((hash) => HASH_HEX.test(hash)).sort();
  const parent = unique.map((_, i) => i);

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a === b) return;
    // 字典序小的是根：簇 key 与遍历顺序无关
    if (a < b) parent[b] = a;
    else parent[a] = b;
  };

  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      if (hammingDistance(unique[i], unique[j]) <= maxDistance) union(i, j);
    }
  }

  const clusters = new Map<string, string>();
  for (let i = 0; i < unique.length; i++) clusters.set(unique[i], unique[find(i)]);
  return clusters;
}
