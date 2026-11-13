import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig: NextConfig = {
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  reactStrictMode: true,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
  /**
   * Cloudflare Workers 构建（BUILD_TARGET=workers）时把 Node 版 SSRF 层换成 Workers 版：
   * Node 版依赖 undici Agent + node:dns，Workers 运行时没有这些能力，
   * 静态打入会让 worker 模块加载即失败（详见 src/lib/ssrf-workers.ts 头部注释）。
   */
  webpack: (config, { webpack }) => {
    if (process.env.BUILD_TARGET === 'workers') {
      const workersSSRF = path.join(process.cwd(), 'src', 'lib', 'ssrf-workers.ts');
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^(?:\.\/ssrf|@\/lib\/ssrf)$/, (resource: { request: string }) => {
          resource.request = workersSSRF;
        })
      );
    }
    return config;
  },
};

export default nextConfig;
