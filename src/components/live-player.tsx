'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';
import { Spinner } from './states';
import { useMediaSession } from '@/components/use-media-session';
import { buildMediaInfo, type MediaArtwork } from '@/lib/media-session';
import { prefersTouchPointer } from '@/lib/touch-pointer';
import { ART_DEFAULT_CONTROL_HIDE_MS, TOUCH_CONTROL_HIDE_MS } from '@/lib/control-hide';
import { attachVolumeBoost, type VolumeBoostHandle } from '@/lib/volume-boost';
import {
  bindFullscreenIconSync,
  fullscreenButtonHtml,
  togglePlayerFullscreen,
} from '@/lib/player-fullscreen';
import {
  bindPipIconSync,
  pipButtonHtml,
  togglePictureInPicture,
} from '@/lib/player-picture-in-picture';
import { GmFetchHlsLoader } from '@/lib/gm-hls-loader';
import { hasGmFetch } from '@/lib/gm-fetch';

/**
 * 直播播放器：与点播 player-shell 完全独立。
 * - 引擎分发：.m3u8 → hls.js（直播参数）；.flv → mpegts.js（动态加载，按需 ~150KB）；
 *   mp4/webm 等原生容器 → <video> 直接播放；
 * - 无扩展名的地址（如 /channel/xxx?token=...）默认按 HLS 处理，
 *   HLS 直连失败后**回退原生播放**一次（覆盖"内容是 MP4 却无 .m3u8 后缀"的源）；
 * - 只直连源站：CORS / 防盗链失败不经过任何服务器中转，直接提示换频道；
 * - 直播态 UI：无进度条、无倍速、无截图、无连播。
 */

export function isFlvUrl(url: string): boolean {
  return /\.flv(\?|$)/i.test(url);
}

/** 浏览器原生可播的直链容器（非 HLS/FLV） */
const NATIVE_MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|$)/i;

type Engine = 'hls' | 'flv' | 'native';

function engineOf(url: string): Engine {
  if (isFlvUrl(url)) return 'flv';
  if (NATIVE_MEDIA_RE.test(url)) return 'native';
  return 'hls';
}

/**
 * 直连失败的唯一出路：媒体字节不经 Worker（Cloudflare 不允许 CDN/Workers 分发站外视频），
 * CORS / 防盗链拒绝没有代理兜底，只能明确提示用户换频道。
 */
const DIRECT_ONLY_FAILURE = '该源不允许跨域直连（CORS / 防盗链）或已失效，请更换频道';

/**
 * 装了油猴「跨域助手」时的失败文案：请求已由扩展后台发出，CORS 不再是原因，
 * 失败意味着源站拒绝扩展请求（403/防盗链）或地址真的失效。
 */
const GM_DIRECT_FAILURE =
  '已通过跨域助手（GM_fetch）请求，仍失败说明源站拒绝扩展请求或已失效，请更换频道';

interface LivePlayerProps {
  /** 上游直播流地址（只直连源站） */
  url: string;
  title: string;
  /**
   * 系统媒体会话（安卓通知栏/锁屏）副标题行：频道分组（如「央视」）或「直播」。
   * 直播没有进度/集数，只登记台标、频道名与播放控制。
   */
  subtitle?: string;
  /** 媒体会话封面：频道台标，无台标时由页面给站标兜底 */
  artwork?: MediaArtwork;
  /** 上一台/下一台：传入时注册为播放器控制条按钮（全屏内也可操作） */
  onPrevChannel?: () => void;
  onNextChannel?: () => void;
  /** 音量放大（Web Audio 增益链）：默认关闭，关闭时完全不接入音频链路 */
  volumeBoost: boolean;
}

export function LivePlayer({
  url,
  title,
  subtitle,
  artwork,
  onPrevChannel,
  onNextChannel,
  volumeBoost,
}: LivePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mpegtsRef = useRef<any>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [loading, setLoading] = useState(true);
  // 手动重试计数：变化时重建整个播放器实例（比 location.reload() 轻得多）
  const [retryNonce, setRetryNonce] = useState(0);
  // 起播前的品牌加载占位（黑底 + 站标 + 站名，与点播播放器一致），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  // 换台 OSD：切台后短暂显示频道名（键盘换台/控制条换台时的视觉反馈，全屏内同样可见）
  const [osdTitle, setOsdTitle] = useState('');
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 音量放大句柄（换台销毁播放器时释放）；用 ref 才能在设置变化时被另一个 effect 操作 */
  const volumeBoostRef = useRef<VolumeBoostHandle | null>(null);
  // 创建实例的 effect 不依赖 volumeBoost（换台才重建），起播回调靠这个 ref 读最新设置
  const volumeBoostSettingRef = useRef(volumeBoost);
  volumeBoostSettingRef.current = volumeBoost;

  // url 变化即换台：显示频道名 2.5s
  useEffect(() => {
    if (!url) return;
    setOsdTitle(title);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setOsdTitle(''), 2500);
    return () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    };
  }, [url, title]);

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  // —— 系统媒体会话：通知栏/锁屏上的频道名、分组、台标与播放控制 ——
  // 直播没有进度：不注册 seek、不写 setPositionState（直播 duration 是 Infinity，会抛）。
  // 台标**不裁方**：方台标裁了也是原样，而宽版字标（如「CCTV-1」）居中裁方会把字切掉。
  const mediaInfo = useMemo(
    () => buildMediaInfo({ title, subtitle, artwork }),
    [title, subtitle, artwork]
  );
  const mediaSession = useMediaSession({
    info: mediaInfo,
    canSeek: false,
    canPrev: Boolean(onPrevChannel),
    canNext: Boolean(onNextChannel),
    actions: {
      play: () => {
        Promise.resolve(artRef.current?.play()).catch(() => {});
      },
      pause: () => {
        try {
          artRef.current?.pause();
        } catch {
          /* 忽略 */
        }
      },
      prev: () => onPrevChannel?.(),
      next: () => onNextChannel?.(),
    },
  });

  useEffect(() => {
    if (!containerRef.current || !url) return;
    setError('');
    setLoading(true);
    setShowPoster(true);

    // 直播的错误/重试由本组件统一负责：关掉 ArtPlayer 自带的 5 次自动重连，
    // 否则它会和 hls.js 的 liveNetRetryCount 各跑一套，界面上还会闪「重新连接: N」。
    const prevReconnectMax = Artplayer.RECONNECT_TIME_MAX;
    Artplayer.RECONNECT_TIME_MAX = 0;

    let playbackStarted = false;
    let disposed = false;
    let destroyed = false;
    /** 原生播放注册的 error 监听清理函数（切台/销毁时调用） */
    let nativeCleanup: (() => void) | null = null;
    // 油猴「跨域助手」：装了就把 hls.js 的请求交给扩展后台（不受 CORS / 混合内容限制）
    const gmFetchActive = hasGmFetch();
    const directFailure = gmFetchActive ? GM_DIRECT_FAILURE : DIRECT_ONLY_FAILURE;

    const cleanupEngines = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (mpegtsRef.current) {
        try { mpegtsRef.current.pause(); } catch { /* 忽略 */ }
        try { mpegtsRef.current.destroy(); } catch { /* 忽略 */ }
        mpegtsRef.current = null;
      }
      if (nativeCleanup) {
        try { nativeCleanup(); } catch { /* 忽略 */ }
        nativeCleanup = null;
      }
    };

    /**
     * 原生播放：mp4/webm 等容器交给 <video> 直接播放。
     * 也作为 HLS 直连失败后的兜底——覆盖"地址没有 .m3u8 后缀但内容其实是 MP4"的源。
     * 失败即报错：不经过任何代理。
     */
    const setupNative = (
      video: HTMLVideoElement,
      mediaUrl: string,
      failMessage?: string
    ) => {
      cleanupEngines();
      const onError = () => {
        video.removeEventListener('error', onError);
        nativeCleanup = null;
        if (disposed || destroyed) return;
        setError(failMessage || '该地址不是可播放的直播流（内容可能是文件或错误提示）');
      };
      video.addEventListener('error', onError);
      nativeCleanup = () => video.removeEventListener('error', onError);
      video.src = mediaUrl;
      video.load();
      video.play().catch(() => {});
    };

    /** HLS 直播参数：小缓冲、快速追帧；与点播（大缓冲、进度恢复）刻意区分 */
    const setupHls = (video: HTMLVideoElement, mediaUrl: string) => {
      cleanupEngines();
      let liveNetRetryCount = 0;
      let mediaRecoverCount = 0;
      const hlsConfig: Partial<HlsConfig> = {
        debug: false,
        enableWorker: true,
        liveSyncDurationCount: 3,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 4,
        fragLoadingRetryDelay: 800,
      };
      // 装了跨域助手时换掉 hls.js 的默认 XhrLoader：源站没有 ACAO 也能拿到 manifest/分片
      if (gmFetchActive) {
        hlsConfig.loader = GmFetchHlsLoader as unknown as HlsConfig['loader'];
      }
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      hls.loadSource(mediaUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, manifestData) => {
        // H.265 检测：大量国内 IPTV 源为 HEVC 编码，Chromium 内核通常无法软解
        const videoCodecs = (manifestData.levels || []).map((l) => l.videoCodec || '').join(',');
        if (/hvc1|hev1|hevc/i.test(videoCodecs)) {
          const support = video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
          if (!support) {
            showHint('该频道为 H.265 编码，当前浏览器可能无法解码，建议用 Edge/Safari');
          }
        }
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (disposed || destroyed) return;
        const httpCode = data.response?.code;
        const codeHint = httpCode ? `（HTTP ${httpCode}）` : '';
        if (!data.fatal) return;
        // 媒体错误：起播前后统一尝试恢复，次数受限防止无限 recover 循环
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecoverCount < 2) {
            mediaRecoverCount++;
            hls.recoverMediaError();
            return;
          }
          setError('直播流解码失败，可能该频道编码不受当前浏览器支持，请尝试其他频道');
          return;
        }
        if (!playbackStarted) {
          // HLS 直连失败：可能是"无 .m3u8 后缀但内容是 MP4"的源，回退原生播放一次；
          // 原生也失败就明确报错，不再经过任何代理。
          showHint('HLS 解析失败，尝试原生播放...');
          setupNative(
            video,
            url,
            `直播流加载失败${codeHint}，${directFailure}`
          );
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // 播放中网络抖动：尝试恢复拉流；连续失败达到阈值则报错退出
          liveNetRetryCount++;
          if (liveNetRetryCount > 5) {
            setError(`直播流中断${codeHint}，该源可能已失效，请尝试其他频道`);
            return;
          }
          hls.startLoad();
        }
      });
    };

    const setupFlv = async (video: HTMLVideoElement, mediaUrl: string) => {
      cleanupEngines();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let Mpegts: any;
      try {
        Mpegts = (await import('mpegts.js')).default;
      } catch {
        setError('FLV 播放模块加载失败，请检查网络后重试');
        return;
      }
      if (disposed || destroyed) return;
      if (!Mpegts.getFeatureList().mseLivePlayback) {
        setError('当前浏览器不支持 FLV 直播播放');
        return;
      }
      const player = Mpegts.createPlayer(
        {
          type: 'flv',
          isLive: true,
          url: mediaUrl,
        },
        {
          enableWorker: false,
          enableStashBuffer: false,
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          lazyLoad: false,
        }
      );
      mpegtsRef.current = player;
      player.attachMediaElement(video);
      player.load();
      player.on(Mpegts.Events.ERROR, (errType: string) => {
        if (disposed || destroyed) return;
        setError(`直播流加载失败（${errType}），${DIRECT_ONLY_FAILURE}`);
      });
      player.play().catch(() => {});
    };

    const engine = engineOf(url);
    // 上一台/下一台：注册到播放器控制条（普通态与全屏均可见），未传不显示
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const controls: any[] = [];
    const channelBtnSvg = (path: string) =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="${path}"/></svg>`;
    if (onPrevChannel) {
      controls.push({
        name: 'prev-channel',
        position: 'left',
        // 注意不能写 0：ArtPlayer 的 add() 用 `option.index || this.id`，0 会被自增 id 顶掉，
        // 导致上一台/下一台同 index、后加的下一台插到上一台前面（截图里的 ⏭ ⏮ ▶）。
        // 11/12 让它们在播放键（index 10）之后、音量（20）之前，顺序为 ▶ ⏮ ⏭。
        index: 11,
        html: channelBtnSvg('M11 19l-7-7 7-7m8 14l-7-7 7-7'),
        tooltip: '上一台',
        click: () => onPrevChannel(),
      });
    }
    if (onNextChannel) {
      controls.push({
        name: 'next-channel',
        position: 'left',
        index: 12,
        html: channelBtnSvg('M13 5l7 7-7 7M5 5l7 7-7 7'),
        tooltip: '下一台',
        click: () => onNextChannel(),
      });
    }
    // 小窗播放：自定义按钮（不支持时给中文提示，手机上保持可见）
    controls.push({
      name: 'pip',
      position: 'right',
      index: 40,
      html: pipButtonHtml,
      tooltip: '小窗播放',
      click: () => {
        togglePictureInPicture(artRef.current, () =>
          showHint('当前浏览器不支持小窗播放，请用系统浏览器打开')
        );
      },
    });
    // 全屏降级链（lib/player-fullscreen，与点播 player-shell 同一套）：
    // 手机走 CSS 旋转横屏，桌面走容器全屏 → video 全屏 → 网页全屏
    controls.push({
      name: 'fullscreen',
      position: 'right',
      index: 70,
      html: fullscreenButtonHtml,
      tooltip: '全屏',
      click: () => {
        void togglePlayerFullscreen(
          artRef.current,
          () => showHint('当前浏览器不支持全屏，已切换网页全屏'),
          () => showHint('浏览器限制，已旋转横屏（再点一次退出）')
        );
      },
    });
    // 触屏没有 hover，原生 3 秒自动隐藏会让直播控制栏（上一台/下一台）点不到
    // （issue #937）：触屏常驻、由点按视频 toggle 收起；桌面行为不变
    const touchPointer = prefersTouchPointer();
    if (touchPointer) Artplayer.CONTROL_HIDE_TIME = TOUCH_CONTROL_HIDE_MS;

    const art = new Artplayer({
      container: containerRef.current,
      url,
      // 原生容器统一用 'mp4'（仅用于选择处理函数，实际容器由浏览器嗅探）
      type: engine === 'flv' ? 'flv' : engine === 'native' ? 'mp4' : 'm3u8',
      volume: 0.9,
      autoplay: true,
      // 直播态：ArtPlayer 原生 isLive 会不创建进度条/时间控件，并禁用移动端拖进度手势
      isLive: true,
      // —— 直播态：关闭点播专属能力 ——
      // 小窗按钮用自定义控件（见 controls），手机上也可见
      pip: false,
      screenshot: false,
      setting: false,
      playbackRate: false,
      aspectRatio: false,
      // 「全屏」改用上面的自定义按钮（fullscreen 降级链），不用库内置按钮
      fullscreenWeb: true,
      miniProgressBar: false,
      hotkey: false,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      theme: '#2563eb',
      controls,
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { playsInline: true },
      customType: {
        m3u8: (video: HTMLVideoElement) => {
          setupHls(video, url);
        },
        flv: (video: HTMLVideoElement) => {
          void setupFlv(video, url);
        },
        mp4: (video: HTMLVideoElement) => {
          setupNative(video, url);
        },
      },
    });
    artRef.current = art;
    // 全屏按钮图标随状态同步（容器全屏 / iOS video 全屏 / 网页全屏三种形态都覆盖）
    const unbindFullscreenIcon = bindFullscreenIconSync(art);
    const unbindPipIcon = bindPipIconSync(art);
    art.on('video:loadedmetadata', () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = title;
      } catch { /* 忽略 */ }
    });
    art.on('video:playing', () => {
      playbackStarted = true;
      setLoading(false);
      setShowPoster(false);
      setError('');
      // 音量放大：起播后（src 已就绪）才挂增益图。默认关闭时完全不接入；
      // 跨域直连流会自动跳过，hls.js 的 blob: 源可安全放大；失败一律原样播放。
      if (volumeBoostSettingRef.current && !volumeBoostRef.current) {
        volumeBoostRef.current = attachVolumeBoost(art.video);
      }
      // 系统媒体会话：锁屏/通知栏的播放按钮状态。观众切后台继续听时，这一行是唯一的「正在播」信号
      mediaSession.setPlaybackState('playing');
    });
    art.on('video:pause', () => {
      mediaSession.setPlaybackState('paused');
    });
    art.on('video:error', () => {
      // mpegts 走自身 ERROR 事件；这里兜底其它未知错误
      if (!mpegtsRef.current) setError('视频播放失败，请尝试其他频道');
    });

    // 15s 内未起播则提示
    const startTimer = setTimeout(() => {
      if (!playbackStarted && !disposed && !destroyed) {
        setError(`频道加载超时，${directFailure}`);
      }
    }, 15000);

    return () => {
      disposed = true;
      clearTimeout(startTimer);
      unbindFullscreenIcon();
      unbindPipIcon();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      cleanupEngines();
      volumeBoostRef.current?.dispose();
      volumeBoostRef.current = null;
      art.destroy();
      artRef.current = null;
      // CONTROL_HIDE_TIME / RECONNECT_TIME_MAX 都是全局 static：恢复库默认值，避免影响其它播放器
      Artplayer.RECONNECT_TIME_MAX = prevReconnectMax;
      if (touchPointer) Artplayer.CONTROL_HIDE_TIME = ART_DEFAULT_CONTROL_HIDE_MS;
      destroyed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryNonce, onPrevChannel, onNextChannel]);

  // —— 音量放大开关：播放中改设置即时生效，不必等重新起播 ——
  // 关闭走「单位增益直通」而不是拆链：createMediaElementSource 之后元素输出只走
  // 音频图，拆链会永久静音且无法恢复直连，所以只旁路增益与限幅。
  useEffect(() => {
    const video = artRef.current?.video as HTMLVideoElement | undefined;
    if (!video) return;
    if (volumeBoost) {
      volumeBoostRef.current = attachVolumeBoost(video) ?? volumeBoostRef.current;
      volumeBoostRef.current?.setBoost(true);
    } else {
      volumeBoostRef.current?.setBoost(false);
    }
  }, [volumeBoost]);

  // 进入错误态时清掉过渡提示（HLS 回退原生播放的 hint 不能和错误一起显示在画面上），
  // 并收起控制条：错误面板是唯一焦点，避免半透明遮罩下还透出播放/换台按钮。
  useEffect(() => {
    const art = artRef.current;
    if (art?.controls) art.controls.show = !error;
    if (!error) return;
    setHint('');
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, [error]);

  return (
    <div className="player-stage relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {/* 起播前的品牌加载占位 */}
      {showPoster && !error && (
        <div className="absolute inset-0 z-[130] bg-black pointer-events-none flex flex-col items-center justify-center gap-3 px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/brand-mark.svg" alt="" className="h-10 sm:h-12 w-auto" />
          <span className="text-2xl sm:text-3xl font-bold brand-gradient tracking-tight">夜幕影视</span>
          <span className="text-[11px] sm:text-xs text-faint">正在加载…</span>
        </div>
      )}
      {/* 换台 OSD：频道名（全屏内同样可见） */}
      {osdTitle && !error && (
        <div className="absolute top-3 left-3 z-[130] flex items-center max-w-[70%] bg-black/60 px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          <span className="text-sm font-medium text-white truncate">{osdTitle}</span>
        </div>
      )}
      {loading && !error && (
        <div className="absolute inset-0 z-[130] flex items-center justify-center bg-black/40 pointer-events-none">
          <Spinner size="lg" tone="onDark" />
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="absolute inset-0 z-[130] flex flex-col items-center justify-center gap-3 bg-black px-6 text-center"
        >
          <p className="text-sm font-medium text-white">频道暂时无法播放</p>
          <p className="max-w-sm text-xs leading-relaxed text-white/70">{error}</p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md bg-white/15 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/25"
              onClick={() => {
                // 重建播放器实例即可，无需整页刷新
                setError('');
                setHint('');
                setRetryNonce((n) => n + 1);
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 z-[130] -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
    </div>
  );
}
