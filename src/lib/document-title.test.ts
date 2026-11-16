import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_TITLE } from './site';
import { shouldApplyDocumentTitle } from './document-title';

const DESIRED = '庆余年 第 2 集 - 夜幕影视';

describe('shouldApplyDocumentTitle', () => {
  it('标题被重置回默认时补写（生产构建 hydration 后的真实场景）', () => {
    expect(shouldApplyDocumentTitle(DEFAULT_DOCUMENT_TITLE, DESIRED, DEFAULT_DOCUMENT_TITLE)).toBe(true);
  });

  it('标题为空时补写', () => {
    expect(shouldApplyDocumentTitle('', DESIRED, DEFAULT_DOCUMENT_TITLE)).toBe(true);
  });

  it('已经是目标标题就不重复写（避免 MutationObserver 自激）', () => {
    expect(shouldApplyDocumentTitle(DESIRED, DESIRED, DEFAULT_DOCUMENT_TITLE)).toBe(false);
  });

  it('别的路由写了自己的标题时不抢', () => {
    expect(shouldApplyDocumentTitle('关于 - 夜幕影视', DESIRED, DEFAULT_DOCUMENT_TITLE)).toBe(false);
  });

  it('没有目标标题时什么都不做', () => {
    expect(shouldApplyDocumentTitle(DEFAULT_DOCUMENT_TITLE, '', DEFAULT_DOCUMENT_TITLE)).toBe(false);
  });
});
