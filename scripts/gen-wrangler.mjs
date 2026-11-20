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
 * tier: 1 是默认首轮搜索的 8 个主力源（2026-11-20 按线上实测速度与片库互补精选）；
 * 其余源只在用户点击「搜索更多源」后查询。用户手动改过选源时不启用分层。
 */

/**
 * 点播源（2026-11-14 全量合并）：35 个源，其中 35 个 search+detail 通过
 * （本次线上复验 20 个 + 原有保留 15 个）、2 个画质可测（height）。
 *
 * 排序（可用性优先）：
 * 1. 画质实测有 height：电影天堂 1080、飘零资源 720；
 * 2. search+detail 通过：原有 13 个保留在前（沿用既有结论，本次未复测），
 *    本次线上复验的 20 个按 search+detail 耗时升序排在后面；
 * 3. 仅搜索可用（详情/画质不通）：本次无（详情不通的源已剔除）。
 *
 * 候选全集 = tested.json ∪ tested2.json ∪ near-miss.json ∪ recommended.json ∪ 原有 15 个，
 * 按规范化 URL 去重（忽略协议与主机大小写、去尾斜杠），同一源的多协议变体只保留复验通过的那个，
 * 名称取第一次出现。成人内容不剔除：9 个成人向源照旧标 isAdult: true（与 DEPLOY-CLOUDFLARE.md
 * 的「18🈲 成人内容标识与开关」一致），搜索结果是否过滤成人条目由站内「成人内容过滤」设置控制。
 *
 * 线上复验（新纳入的源）：POST /api/search（庆余年，无结果再试 流浪地球，filterAdult=false）
 * + GET /api/detail，episodes 非空才算通过；仅成人目录的 森林 / jkun 用第三关键词 狂飙 复验通过。
 * 注：非同源的两个「非凡」（ffzy.tv / cj.ffzyapi.com）名称相同，按原始配置名保留，靠 URL 区分。
 * 验证时间：2026-11-14。
 */
const sources = [
  { name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '飘零资源', url: 'https://p2100.net/api.php/provide/vod', isAdult: false },
  { name: '无尽资源', url: 'https://api.wujinapi.me/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '爱坤资源', url: 'https://ikunzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '优酷资源', url: 'https://api.ukuapi88.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '新狼资源', url: 'https://api.xinlangapi.com/xinlangapi.php/provide/vod', isAdult: false },
  { name: '豪华资源', url: 'https://hhzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '魔都资源', url: 'https://www.mdzyapi.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod', isAdult: false },
  { name: '艾旦影视', url: 'https://lovedan.net/api.php/provide/vod', isAdult: false },
  { name: '速播资源', url: 'https://subocj.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '速博资源', url: 'https://subocaiji.com/api.php/provide/vod', isAdult: false },
  { name: '茅台资源', url: 'https://caiji.maotaizy.cc/api.php/provide/vod', isAdult: false },
  { name: '废柴', url: 'http://fhapi9.com/api.php/provide/vod', isAdult: true },
  { name: '155', url: 'https://155api.com/api.php/provide/vod', isAdult: true },
  { name: '┃量子┃资源', url: 'https://lzizy1.com/api.php/provide/vod', isAdult: false, tier: 1 },
  { name: '暴风影音', url: 'https://app.bfzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '大地', url: 'https://dadiapi.com/api.php/provide/vod', isAdult: true },
  { name: '乐播', url: 'https://lbapi9.com/api.php/provide/vod', isAdult: false },
  { name: '尤酷', url: 'https://api.ukuapi.com/api.php/provide/vod', isAdult: false },
  { name: '┃非凡┃资源', url: 'http://ffzy1.tv/api.php/provide/vod', isAdult: false },
  { name: '非凡', url: 'http://ffzy.tv/api.php/provide/vod', isAdult: false },
  { name: '红牛资源', url: 'http://www.hongniuzy2.com/api.php/provide/vod', isAdult: false },
  { name: '量子', url: 'http://cj.lziapi.com/api.php/provide/vod', isAdult: false },
  { name: '非凡', url: 'http://cj.ffzyapi.com/api.php/provide/vod', isAdult: false },
  { name: '森林', url: 'https://slapibf.com/api.php/provide/vod', isAdult: true },
  { name: '滴滴', url: 'https://api.ddapi.cc/api.php/provide/vod', isAdult: true },
  { name: '精品下', url: 'http://www.jingpinx.com/api.php/provide/vod', isAdult: false },
  { name: '文才资源', url: 'http://api.zeqaht.com/api.php/provide/vod', isAdult: false },
  { name: 'jkun', url: 'https://jkunzyapi.com/api.php/provide/vod', isAdult: true },
  { name: '辣椒', url: 'http://api.11bat.com/api.php/provide/vod', isAdult: true },
  { name: '魔法', url: 'http://madouse.la/api.php/provide/vod', isAdult: true },
  { name: '玉兔资源', url: 'https://apiyutu.com/api.php/provide/vod', isAdult: true },
];

const liveSources = [
  { name: 'iptv-org 中国大陆', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
  { name: 'zbds IPTV4', url: 'https://live.zbds.top/tv/iptv4.m3u' },
  { name: 'aptv 综合', url: 'https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u' },
  {
    name: '4K 专区',
    url: 'https://gist.githubusercontent.com/yifanwang-yet/c2c9263066c0c5d20f50ce9b31d40e7e/raw/libretv-4k.m3u',
  },
  // 2026-11-14 扩容：8 个全部按「全量频道逐个探测 200/206 + ACAO」筛选，约 1398 频道，
  // 与上面 4 个合计 ~2061 频道；粗略估算约 619 条可直连（混合内容 http 流已排除）。
  { name: '海外 FAST 频道（akiralereal）', url: 'https://raw.githubusercontent.com/akiralereal/iptv/main/IPTV-overseas.m3u' },
  { name: 'GNTV 港台/国际/地方（YueChan）', url: 'https://raw.githubusercontent.com/YueChan/Live/main/GNTV.m3u' },
  {
    name: 'Collect-IPTV 省台/轮播',
    url: 'https://raw.githubusercontent.com/zilong7728/Collect-IPTV/refs/heads/main/best_sorted.m3u',
  },
  { name: 'ChinaIPTV 台湾', url: 'https://raw.githubusercontent.com/hujingguang/ChinaIPTV/main/TaiWan.m3u8' },
  { name: 'ChinaIPTV cnTV 自动更新', url: 'https://raw.githubusercontent.com/hujingguang/ChinaIPTV/main/cnTV_AutoUpdate.m3u8' },
  { name: 'iptv-org 台湾', url: 'https://iptv-org.github.io/iptv/countries/tw.m3u' },
  { name: 'iptv-org 香港', url: 'https://iptv-org.github.io/iptv/countries/hk.m3u' },
  { name: 'Guovin iptv-api IPv4', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/ipv4/result.m3u' },
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
    // 35 个源 × 多页 + 重试会超限（实测报 "Too many subrequests"）。
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
  `wrangler.jsonc + bootstrap.generated.json written: ${sources.length} VOD sources, ${liveSources.length} live sources`
);
