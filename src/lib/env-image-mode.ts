export type ImageModeValue = 'direct' | 'proxy';

/**
 * 部署者通过 DEFAULT_IMAGE_MODE 环境变量指定的封面图加载方式默认值。
 * 可选值：direct（原站直连 / 豆瓣走公共镜像）/ proxy（已废弃，等同 direct）。
 * 内置图片代理已删除：封面全部由浏览器直连，不经本站 Worker；保留 proxy 取值只为兼容旧部署，
 * 传入时告警并按 direct 处理。
 * 未配置返回 undefined（沿用内置默认 direct）；取值非法时告警并忽略，不影响站点运行。
 */
export function getEnvImageMode(): ImageModeValue | undefined {
  const raw = process.env.DEFAULT_IMAGE_MODE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'direct') return raw;
  if (raw === 'proxy') {
    console.warn('[LibreTV] DEFAULT_IMAGE_MODE=proxy 已废弃（图片代理已移除），按 direct 处理');
    return 'direct';
  }
  console.warn(
    '[LibreTV] DEFAULT_IMAGE_MODE 取值无效，已忽略（可选 direct）：',
    raw
  );
  return undefined;
}
