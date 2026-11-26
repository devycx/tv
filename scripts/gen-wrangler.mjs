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
 *
 * 2026-11-26 大陆口径复测（tv/.tmp/mainland-playback-probe.mjs，深圳移动直连，
 * 并发打真实 m3u8）：暴风播放域名中位 4.3s 降到 Tier 2，量子 672ms 升到 Tier 1。
 * 注意源顺序不能改：env_N 的 key 由数组下标生成，重排会让老用户的勾选错位。
 * 另外大陆 API 域名被阻断（红牛/速博/如意等）不影响搜索——取数走 CF Worker；
 * 只影响浏览器直连的播放，所以分层依据是播放延迟而非 API 可达性。
 */

/**
 * 点播源 · 综合（2026-11-20 实测 top10，顺序即榜单顺序）
 *
 * 口径：228 个去重采集接口 → 5 关键词检索 → 片库规模 → 3 轮延迟中位数 →
 * 线路感知的真播（master → variant → 首分片，2xx 且 >1KB，不看 manifest 就算过）。
 * 排序依据是「检索覆盖 100 分制 + 片库 + 延迟」，明细见 libretv-source-audit/README.md。
 *
 * 上线后又按**线上出口**复验了一轮（同一组关键词 庆余年/哪吒/狂飙，走部署好的
 * Worker 的 /api/search）。这一步筛掉了本地测得了、线上却拿不到的源：
 * Cloudflare 的 525「SSL handshake failed」出现在一批源站本身也挂在 Cloudflare
 * 后面的接口上（量子、如意、红牛、360、1080、爱奇艺、新狼、鲨鱼、废柴、精品下）。
 * 这些站**换成 http 入口就能通**（Worker → 源站不再走 TLS），所以下面保留的
 * http 源不是笔误。360 / 最大资源 / 茅台 / 玉兔 同协议也不通（525 或 0 条），已剔除。
 */
const sources = [
  // 线上 3 词合计 52 / 63ms，片库 190,116（本地测延迟高是因为香港出口，Cloudflare 边缘很快）
  { name: '艾旦影视', url: 'https://lovedan.net/api.php/provide/vod', isAdult: false, tier: 1 },
  // 2026-11-26 大陆直连复测：播放域名 s3.bfllvip.com 中位 4.3s（全表最慢），降 Tier 2
  { name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '无尽资源', url: 'https://api.wujinapi.me/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '豪华资源', url: 'https://hhzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '速博资源', url: 'https://subocaiji.com/api.php/provide/vod', isAdult: false, tier: 1 },
  // 红牛 14 个候选里唯一 525 的 https 入口，改 http 后 3/3 命中
  { name: '红牛资源', url: 'http://www.hongniuzy2.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '如意资源', url: 'http://cj.rycjapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  // 量子线上用 cj.lziapi.com 拿不到（525），lzizy1 是同一后端（片库都是 164,649）
  // 2026-11-26 大陆直连复测：播放域名 v.cdnlz28.com 中位 672ms、片库 164k，升 Tier 1
  { name: '量子资源', url: 'https://lzizy1.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '非凡资源', url: 'http://ffzy.tv/api.php/provide/vod', isAdult: false },

  /**
   * 点播源 · 18+（2026-11-20 实测 top10）
   *
   * 口径：101 个可用接口里先按 60 条最新片名 + 分类表判成人占比，再交叉
   * play3 的真播结果；只留「成人内容为主 + 至少一条线路真能播」的源，
   * 按片库规模排序后逐条复验 search → detail → master/variant/分片，
   * 并要求播放链带 Access-Control-Allow-Origin（播放器是浏览器直连，没有代理）。
   * 明细见 libretv-source-audit/README-adult.md。
   *
   * 同上的线上复验：鲨鱼 / 废柴 / 精品下 / 辣椒 的 https 入口是 525，换 http 后
   * 每个都 3/3 命中 20 条；玉兔两个协议都 >3s 超时，移出替换名单（麻豆 / 滴滴 替补）。
   */
  { name: '乐播', url: 'https://lbapi9.com/api.php/provide/vod', isAdult: true },
  { name: '鲨鱼', url: 'http://shayuapi.com/api.php/provide/vod', isAdult: true },
  { name: '大地', url: 'https://dadiapi.com/api.php/provide/vod', isAdult: true },
  { name: '森林', url: 'https://slapibf.com/api.php/provide/vod', isAdult: true },
  { name: '废柴', url: 'http://fhapi9.com/api.php/provide/vod', isAdult: true },
  { name: '辣椒', url: 'http://api.11bat.com/api.php/provide/vod', isAdult: true },
  { name: '155', url: 'https://155api.com/api.php/provide/vod', isAdult: true },
  { name: '魔法', url: 'https://madouse.la/api.php/provide/vod', isAdult: true },
  { name: '精品下', url: 'http://www.jingpinx.com/api.php/provide/vod', isAdult: true },
  { name: '滴滴', url: 'https://api.ddapi.cc/api.php/provide/vod', isAdult: true },
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
    // 邮箱白名单通道（2026-11-25）：登录页输入命中名单的邮箱直接进站，不发验证码、
    // 不需要密码。门票是「知道邮箱」这个知识，放 vars（非 secret）便于随时增删。
    GATE_EMAILS: 'test@ycxdev.com',
    // 临时公开开关（2026-11-25，给朋友分享）：middleware 与 api-guard 见此值完全旁路鉴权。
    // 恢复门禁：删掉这一行重跑脚本再部署（PASSWORD secret 未动，门禁立即恢复）。
    PUBLIC_MODE: '1',
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
  // PUBLIC_MODE（临时公开）下前端无 401 路径，标记为不需要密码。
  passwordRequired: process.env.PUBLIC_MODE !== '1',
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
  // 首页推荐默认豆瓣（未显式配置 DEFAULT_RECOMMEND_SOURCE 时）
  defaultRecommendSource: ['douban', 'bangumi', 'hot-list'].includes(
    process.env.DEFAULT_RECOMMEND_SOURCE?.trim().toLowerCase() ?? ''
  )
    ? process.env.DEFAULT_RECOMMEND_SOURCE.trim().toLowerCase()
    : 'douban',
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
