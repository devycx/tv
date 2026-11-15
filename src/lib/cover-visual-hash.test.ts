import { describe, expect, it } from 'vitest';
import {
  clusterCoverHashes,
  coverCropRect,
  dHashFromLuma,
  dHashFromRgba,
  hammingDistance,
} from './cover-visual-hash';

/** 构造 9×8 行优先的亮度数组 */
function lumaGrid(rows: number[][]): number[] {
  return rows.flat();
}

describe('dHashFromLuma', () => {
  it('每行「暗→亮」交替时得到 aaaa…；全相等时为 0', () => {
    const alternating = lumaGrid(
      Array.from({ length: 8 }, () => [0, 255, 0, 255, 0, 255, 0, 255, 0])
    );
    expect(dHashFromLuma(alternating)).toBe('aaaaaaaaaaaaaaaa');

    const flat = lumaGrid(Array.from({ length: 8 }, () => Array(9).fill(128)));
    expect(dHashFromLuma(flat)).toBe('0000000000000000');
  });

  it('长度不是 9×8 时抛错', () => {
    expect(() => dHashFromLuma([0])).toThrow();
  });
});

describe('dHashFromRgba', () => {
  it('黑白像素按亮度比较，与灰度输入一致', () => {
    const rgba = new Uint8ClampedArray(9 * 8 * 4);
    for (let i = 0; i < 9 * 8; i++) {
      // 每行重新从黑开始，保持 0/255 交替
      const value = (i % 9) % 2 === 0 ? 0 : 255;
      rgba[i * 4] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }
    // 每 9 个像素一行，偶数下标为黑、奇数为白：比较结果取决于行内位置
    expect(dHashFromRgba(rgba)).toBe(dHashFromLuma(Array.from({ length: 8 }, () => [0, 255, 0, 255, 0, 255, 0, 255, 0]).flat()));
  });
});

describe('coverCropRect（指纹取景：中心裁成 4:5）', () => {
  it('竖图（9:16）裁掉上下，保留中间 4:5', () => {
    expect(coverCropRect(540, 960)).toEqual({ sx: 0, sy: 142.5, sw: 540, sh: 675 });
  });

  it('2:3 海报也裁掉一点上下（4:5 比 2:3 更宽）', () => {
    const rect = coverCropRect(270, 405);
    expect(rect.sx).toBe(0);
    expect(rect.sw).toBe(270);
    expect(rect.sh).toBeCloseTo(337.5);
    expect(rect.sy).toBeCloseTo(33.75);
  });

  it('方图/横图裁掉左右，保持高度', () => {
    expect(coverCropRect(100, 100)).toEqual({ sx: 10, sy: 0, sw: 80, sh: 100 });
    expect(coverCropRect(1600, 900)).toEqual({ sx: 440, sy: 0, sw: 720, sh: 900 });
  });

  it('尺寸非法时原样返回，交给 drawImage 报错/兜底', () => {
    expect(coverCropRect(0, 100)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 100 });
  });
});

describe('hammingDistance', () => {
  it('按位统计差异', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingDistance('not-a-hash', '0000000000000000')).toBe(Infinity);
  });
});

describe('clusterCoverHashes', () => {
  it('距离阈值内传递合并，簇代表取字典序最小', () => {
    const a = '0000000000000000';
    const b = '0000000000000001'; // 距 a 1
    const c = '0000000000000003'; // 距 a 2，距 b 1 → 传递合并
    const d = 'ffffffffffffffff';

    const clusters = clusterCoverHashes([b, d, a, c]);
    expect(new Set([a, b, c].map((h) => clusters.get(h)))).toEqual(new Set([a]));
    expect(clusters.get(d)).toBe(d);
  });

  it('不同海报距离很远时不合并', () => {
    const clusters = clusterCoverHashes(['b25eb2aa76e2b132', 'b636b2aa76e2e13a', '7cf4e1d3d5d496e8']);
    expect(clusters.get('b25eb2aa76e2b132')).toBe(clusters.get('b636b2aa76e2e13a'));
    expect(clusters.get('b25eb2aa76e2b132')).not.toBe(clusters.get('7cf4e1d3d5d496e8'));
  });

  it('忽略非法指纹', () => {
    const clusters = clusterCoverHashes(['zzz', '0000000000000000']);
    expect(clusters.size).toBe(1);
    expect(clusters.has('zzz')).toBe(false);
  });
});
