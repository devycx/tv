import { describe, expect, it } from 'vitest';
import { centerSquareCrop, cropToSquareBlob, isNearlySquare } from './square-artwork';

/**
 * 只测纯几何与 SSR 安全：canvas 合成在真机/浏览器里验（node 环境没有 Image/Canvas）。
 * 盯的是「竖版海报裁中间最大正方形」这几条坐标，算错会偏到角上。
 */

describe('centerSquareCrop', () => {
  it('竖版海报（豆瓣 540×800）取中间 540×540，输出缩到 512', () => {
    expect(centerSquareCrop(540, 800)).toEqual({ sx: 0, sy: 130, source: 540, output: 512 });
  });

  it('小图不放大：270×400 输出 270×270', () => {
    expect(centerSquareCrop(270, 400)).toEqual({ sx: 0, sy: 65, source: 270, output: 270 });
  });

  it('方图原尺寸裁切，只缩到上限', () => {
    expect(centerSquareCrop(1000, 1000)).toEqual({ sx: 0, sy: 0, source: 1000, output: 512 });
  });

  it('横版图按左右居中裁', () => {
    expect(centerSquareCrop(800, 540)).toEqual({ sx: 130, sy: 0, source: 540, output: 512 });
  });

  it('maxSide 可下调（低端机 256）', () => {
    expect(centerSquareCrop(540, 800, 256).output).toBe(256);
  });

  it('非法尺寸不产生 0 边长', () => {
    expect(centerSquareCrop(0, 0).source).toBe(1);
  });
});

describe('isNearlySquare', () => {
  it('方差在 2% 以内视为方图（台标、方版海报不再重编码）', () => {
    expect(isNearlySquare(512, 512)).toBe(true);
    expect(isNearlySquare(512, 514)).toBe(true);
    expect(isNearlySquare(540, 800)).toBe(false);
  });

  it('尺寸缺失时返回 false', () => {
    expect(isNearlySquare(0, 0)).toBe(false);
  });
});

describe('cropToSquareBlob', () => {
  it('node 环境（无 document）直接返回 null，调用方回退原图', async () => {
    expect(await cropToSquareBlob('https://example.com/a.jpg')).toBeNull();
  });
});
