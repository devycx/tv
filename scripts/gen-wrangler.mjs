import fs from 'node:fs';

/**
 * 生成 wrangler.jsonc（一次性脚本，运行：node scripts/gen-wrangler.mjs）
 *
 * 把点播源 / 直播源写进 Worker 的 vars：
 * - DEFAULT_SOURCES：部署者预置点播源，登录后自动勾选，开箱即搜
 * - DEFAULT_LIVE_SOURCES：部署者预置直播源，/live 页直接可看
 *
 * 修改源列表后重跑本脚本生成 wrangler 配置与首屏 bootstrap。
 *
 * 2026-11-20 换榜：全部 20 个点播源 + 10 个直播源都来自
 * `libretv-source-audit/` 的实测榜单（同一天按同一口径重测），
 * 旧的全量合并列表（35 源）整体作废。三份榜单：
 * - 综合点播 top10 → libretv-top10.json / README.md
 * - 18+ 点播 top10 → adult-top10.json / README-adult.md
 * - 直播源 top10   → live-top10.json  / README-live.md
 *
 * tier: 1 是默认首轮搜索的 8 个综合主力源；其余源只在用户点击「搜索更多源」后
 * 查询。用户手动改过选源时不启用分层。18+ 源一律不标 tier：它们在站内「成人内容
 * 过滤」关闭时才参与搜索，不该出现在首屏的固定 8 源里。
 */

/**
 * 点播源 · 综合（2026-11-20 实测 top10，顺序即榜单顺序）
 *
 * 口径：228 个去重采集接口 → 5 关键词检索 → 片库规模 → 3 轮延迟中位数 →
 * 线路感知的真播（master → variant → 首分片，2xx 且 >1KB，不看 manifest 就算过）。
 * 排序依据是「检索覆盖 100 分制 + 片库 + 延迟」，明细见 libretv-source-audit/README.md。
 */
const sources = [
  { name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '最大资源', url: 'https://api.zuidapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '金鹰资源', url: 'https://jyzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '无尽资源', url: 'https://api.wujinapi.me/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '爱坤资源', url: 'https://ikunzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '360资源', url: 'https://360zy.com/api.php/provide/vod', isAdult: false },
  { name: '1080资源库', url: 'https://api.1080zyku.com/inc/apijson.php', isAdult: false },

  /**
   * 点播源 · 18+（2026-11-20 实测 top10）
   *
   * 口径：101 个可用接口里先按 60 条最新片名 + 分类表判成人占比，再交叉
   * play3 的真播结果；只留「成人内容为主 + 至少一条线路真能播」的源，
   * 按片库规模排序后逐条复验 search → detail → master/variant/分片，
   * 并要求播放链带 Access-Control-Allow-Origin（播放器是浏览器直连，没有代理）。
   * 明细见 libretv-source-audit/README-adult.md。
   *
   * 注：辣椒只有 http 入口（https 不可达），服务端代理拉取不受影响。
   */
  { name: '乐播', url: 'https://lbapi9.com/api.php/provide/vod', isAdult: true },
  { name: '鲨鱼', url: 'https://shayuapi.com/api.php/provide/vod', isAdult: true },
  { name: '大地', url: 'https://dadiapi.com/api.php/provide/vod', isAdult: true },
  { name: '森林', url: 'https://slapibf.com/api.php/provide/vod', isAdult: true },
  { name: '废柴', url: 'https://fhapi9.com/api.php/provide/vod', isAdult: true },
  { name: '辣椒', url: 'http://api.11bat.com/api.php/provide/vod', isAdult: true },
  { name: '玉兔资源', url: 'https://apiyutu.com/api.php/provide/vod', isAdult: true },
  { name: '155', url: 'https://155api.com/api.php/provide/vod', isAdult: true },
  { name: '魔法', url: 'https://madouse.la/api.php/provide/vod', isAdult: true },
  { name: '精品下', url: 'https://www.jingpinx.com/api.php/provide/vod', isAdult: true },
];

/**
 * 直播源（2026-11-20 实测 top10）
 *
 * 播放器是浏览器直连 CDN，没有服务端中转，所以每个列表都过四道：
 * 1. 列表级：能拉、有 ACAO（/live 首屏是浏览器直连列表，失败才回退代理）；
 * 2. 频道级：抽样 110 个（按分组分层），https + 200/206 + 真实 m3u8/ts；
 * 3. 直连级：带 Access-Control-Allow-Origin（没有 ACAO 的频道浏览器必拦）；
 * 4. 分片级：抽 25 个直连频道追 master → variant → 首分片，2xx 且 >1KB 才算稳。
 *
 * 综合分 = 规模（估算可直连频道数的 log）+ 分片通过率 + 可达率 + 延迟 + https 占比，
 * 小列表（<25 个可直连）另扣分。明细见 libretv-source-audit/README-live.md。
 */
const liveSources = [
  { name: 'GNTV 港台/国际/地方', url: 'https://raw.githubusercontent.com/YueChan/Live/main/GNTV.m3u' },
  { name: 'iptv-org 全球', url: 'https://iptv-org.github.io/iptv/index.m3u' },
  { name: 'iptv-org 新闻', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { name: 'iptv-org 体育', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  {
    name: 'Collect-IPTV 省台/轮播',
    url: 'https://raw.githubusercontent.com/zilong7728/Collect-IPTV/refs/heads/main/best_sorted.m3u',
  },
  { name: '海外 FAST 频道', url: 'https://raw.githubusercontent.com/akiralereal/iptv/main/IPTV-overseas.m3u' },
  {
    name: 'Guovin 央视/卫视 IPv4',
    url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/ipv4/result.m3u',
  },
  { name: 'Guovin 综合', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u' },
  { name: 'iptv-org 电影', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { name: 'zbds 央视/卫视', url: 'https://live.zbds.top/tv/iptv4.m3u' },
];

const config = {
  $schema: 'node_modules/wrangler/config-schema.json',
  name: 'tv',
  // 入口包了一层缓存（src/cf-entry.ts）：已登录用户的重复页面/API 请求直接由
  // Cloudflare Cache API 命中，不再进入 Next 运行时，以压低免费套餐的 CPU 占用。
  main: 'src/cf-entry.ts',
  compatibility_date: '2026-11-01',
  compatibility_flags: ['nodejs_compat'],
  assets: { directory: '.open-next/assets', binding: 'ASSETS' },
  observability: { enabled: true },
  // 每次部署生成新的版本 ID，cf-entry.ts 用它当前缀让旧缓存自然失效
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  workers_dev: true,
  preview_urls: false,
  routes: [{ pattern: 'tv.ycxdev.com', custom_domain: true }],
  vars: {
    DEFAULT_SOURCES: JSON.stringify(sources),
    DEFAULT_LIVE_SOURCES: JSON.stringify(liveSources),
    // Workers 免费版单次 invocation 只有 50 个 subrequest：
    // 20 个源 × 多页 + 重试会超限（实测报 "Too many subrequests"）。
    // 每个源只抓第一页、关闭重试，把最坏情况压到「源数量 + 少量重定向」。
    SEARCH_MAX_PAGES: '1',
    SEARCH_SOURCE_TIMEOUT_MS: '3000',
    MAX_RETRIES: '0',
    // 部署矩阵开关（见 src/app/api/auth/route.ts）：Workers 前面只有 Cloudflare 边缘，
    // cf-connecting-ip 由边缘覆写、客户端伪造无效，登录限流必须按它计数。
    // 注意：Node / Docker + 可信反代部署不要照抄这一条，否则客户端可伪造 cf-connecting-ip
    // 绕过限流（那里应改用反代覆写的 x-real-ip / x-forwarded-for）。
    TRUST_CF_IP: '1',
  },
};

fs.writeFileSync('wrangler.jsonc', `${JSON.stringify(config, null, 2)}\n`, 'utf8');

/**
 * 生成首屏 bootstrap（构建期静态注入，页面加载不再请求 /api/status）。
 * 必须与 env-sources.ts / env-live-sources.ts 的 key 与归一化规则保持一致：
 * key 用 env_N / envlive_N，URL 去掉尾部斜杠，字段名不变。
 */
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const bootstrap = {
  version: pkg.version || '0.0.0',
  // 本部署始终配置了 PASSWORD secret；未配置时登录接口会 503 并显示错误。
  passwordRequired: true,
  defaultSources: sources.map((s, i) => ({
    key: `env_${i}`,
    name: s.name,
    url: s.url.replace(/\/+$/, ''),
    ...(s.detail ? { detail: s.detail } : {}),
    isAdult: s.isAdult === true,
    ...(s.tier === 1 ? { tier: 1 } : {}),
  })),
  defaultLiveSources: liveSources.map((s, i) => ({
    key: `envlive_${i}`,
    name: s.name,
    url: s.url.replace(/\/+$/, ''),
    ...(s.epg ? { epg: s.epg } : {}),
  })),
  defaultSubscriptions: [],
  defaultRecommendSource: null,
  defaultImageMode: null,
};
fs.writeFileSync(
  'src/lib/bootstrap.generated.json',
  `${JSON.stringify(bootstrap, null, 2)}\n`,
  'utf8'
);
console.log(
  `wrangler.jsonc + bootstrap.generated.json written: ${sources.length} VOD sources (${
    sources.filter((s) => s.isAdult).length
  } adult, ${sources.filter((s) => s.tier === 1).length} tier-1), ${liveSources.length} live sources`
);
