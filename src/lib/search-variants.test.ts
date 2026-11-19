import { describe, expect, it } from 'vitest';
import { isCommentaryName, variantOf } from './search-variants';

describe('variantOf（片名/类型里的变体识别）', () => {
  it('识别方括号里的电影解说、影视解说', () => {
    expect(variantOf({ name: '香蜜沉沉烬如霜[电影解说]' })).toMatchObject({
      label: '解说',
      fullLabel: '电影解说',
      commentary: true,
    });
    expect(variantOf({ name: '祭弑【影视解说】' })).toMatchObject({
      label: '解说',
      fullLabel: '影视解说',
      commentary: true,
    });
    expect(variantOf({ name: '淡蓝琥珀（无障碍解说版）' })).toMatchObject({
      label: '解说',
      fullLabel: '无障碍解说版',
      commentary: true,
    });
  });

  it('识别片名末尾的沉浸版 / 解说版 / 网络版', () => {
    expect(variantOf({ name: '后会友期 沉浸版' })).toMatchObject({
      label: '沉浸版',
      fullLabel: '沉浸版',
      commentary: false,
    });
    expect(variantOf({ name: '从红月开始 解说版' })).toMatchObject({
      label: '解说',
      fullLabel: '解说版',
      commentary: true,
    });
    expect(variantOf({ name: '香蜜沉沉烬如霜网络版' })).toMatchObject({
      label: '网络版',
      fullLabel: '网络版',
      commentary: false,
    });
  });

  it('识别预告片 / 花絮 / 未删减 / 加长版', () => {
    expect(variantOf({ name: '某片[预告片]' })?.label).toBe('预告片');
    expect(variantOf({ name: '某片 花絮' })?.label).toBe('花絮');
    expect(variantOf({ name: '某片 未删减版' })?.label).toBe('未删减');
    expect(variantOf({ name: '某片 加长版' })?.label).toBe('加长版');
  });

  it('片名本身含解说/沉浸不算变体', () => {
    expect(variantOf({ name: '默片解说员' })).toBeUndefined();
    expect(variantOf({ name: '爱的沉浸式' })).toBeUndefined();
    expect(variantOf({ name: '铁达尼邮轮沉浸记' })).toBeUndefined();
    expect(variantOf({ name: '解说员的故事' })).toBeUndefined();
  });

  it('括号里是画质/语言附注时不算变体', () => {
    expect(variantOf({ name: '色，戒[HD国语]' })).toBeUndefined();
    expect(variantOf({ name: '色，戒【粤语中字】' })).toBeUndefined();
    expect(variantOf({ name: '色，戒（2024）' })).toBeUndefined();
  });

  it('片名没有后缀时看 typeName', () => {
    expect(variantOf({ name: '焦土', typeName: '电影解说' })).toMatchObject({
      label: '解说',
      commentary: true,
    });
    expect(variantOf({ name: '焦土', typeName: '剧情片' })).toBeUndefined();
  });

  it('正片返回 undefined', () => {
    expect(variantOf({ name: '香蜜沉沉烬如霜', typeName: '国产剧' })).toBeUndefined();
    expect(variantOf({ name: '色，戒2007' })).toBeUndefined();
  });

  it('isCommentaryName 只认二创解说，不把沉浸版当解说', () => {
    expect(isCommentaryName('色，戒[电影解说]')).toBe(true);
    expect(isCommentaryName('后会友期 沉浸版')).toBe(false);
    expect(isCommentaryName('默片解说员')).toBe(false);
  });
});
