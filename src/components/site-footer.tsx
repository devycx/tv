'use client';

/**
 * 全站统一页脚。
 *
 * 2026-11-14 换品牌时重写：去掉上游 GitHub 链接与「上游最新版本」检测
 * （原实现每次会话都要请求一次 api.github.com），改为自有品牌 + 授权说明。
 * 项目仍以 AGPL-3.0 发布，源代码在部署仓库中可获取，页脚保留许可声明即可满足要求。
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line py-4">
      <p className="text-center text-xs text-faint">夜幕影视</p>
      <p className="mt-1 text-center text-[11px] text-faint/70">
        仅供个人学习使用 · 基于开源项目（AGPL-3.0）
      </p>
    </footer>
  );
}
