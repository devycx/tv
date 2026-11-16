'use client';

import { useEffect, useMemo, useRef } from 'react';
import { buildPositionState, supportsMediaSession, type MediaInfo } from '@/lib/media-session';

/**
 * 把当前播放内容注册到系统媒体会话：安卓通知栏/锁屏、Windows 媒体浮层、桌面媒体控件。
 *
 * 只做三件事，且都与具体 <video> 元素无关（ArtPlayer 错误恢复时会重建 video，
 * 媒体会话是 document 级的，正好不受影响）：
 * - metadata：片名 + 集数 + 封面；
 * - playbackState：playing / paused，让系统图标和锁屏按钮状态正确；
 * - action：通知栏/锁屏/耳机按键的回调，是否注册由调用方能力决定。
 *
 * 注意：**不要**因为切后台/锁屏就把状态设成 paused —— 那正是用户要它继续播的场景。
 */

export type MediaPlaybackState = 'none' | 'paused' | 'playing';

export interface MediaSessionActions {
  play?: () => void;
  pause?: () => void;
  /** 绝对跳转：通知栏拖动进度条 */
  seekTo?: (seconds: number) => void;
  /** 相对跳转：delta 已带符号（后退为负） */
  seekBy?: (delta: number) => void;
  prev?: () => void;
  next?: () => void;
}

export interface MediaSessionHandle {
  setPlaybackState: (state: MediaPlaybackState) => void;
  /** timeupdate 每 250ms 一次，内部节流到 1s */
  updatePosition: (position: number, duration: number, playbackRate?: number) => void;
  clearPosition: () => void;
}

const POSITION_THROTTLE_MS = 1000;
const NOOP_HANDLE: MediaSessionHandle = {
  setPlaybackState: () => {},
  updatePosition: () => {},
  clearPosition: () => {},
};

interface UseMediaSessionOptions {
  /** null = 没有可播内容：清空系统媒体会话 */
  info: MediaInfo | null;
  canSeek?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  actions: MediaSessionActions;
}

export function useMediaSession({
  info,
  canSeek = false,
  canPrev = false,
  canNext = false,
  actions,
}: UseMediaSessionOptions): MediaSessionHandle {
  // 回调与内容都走 ref：注册 handler 的 effect 只按「能力」重建，不受每次渲染的新闭包影响
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const infoRef = useRef(info);
  infoRef.current = info;
  const lastPositionAtRef = useRef(0);

  // 内容去重键：对象每次渲染都是新引用，直接进 deps 会每帧重建 MediaMetadata
  const infoKey = info ? JSON.stringify(info) : '';

  const handle = useMemo<MediaSessionHandle>(() => {
    if (!supportsMediaSession()) return NOOP_HANDLE;
    return {
      setPlaybackState(state) {
        try {
          navigator.mediaSession.playbackState = state;
        } catch {
          /* 部分浏览器只读/不支持，忽略 */
        }
        // 播放/暂停是「此刻进度」最权威的时机：重置节流，让紧随其后的 updatePosition 立即生效
        lastPositionAtRef.current = 0;
      },
      updatePosition(position, duration, playbackRate = 1) {
        const now = Date.now();
        if (now - lastPositionAtRef.current < POSITION_THROTTLE_MS) return;
        const state = buildPositionState(position, duration, playbackRate);
        if (!state) return; // 直播 / 元数据未就绪：不写，别让 Safari 抛异常
        try {
          navigator.mediaSession.setPositionState?.(state);
          lastPositionAtRef.current = now;
        } catch {
          /* 忽略 */
        }
      },
      clearPosition() {
        lastPositionAtRef.current = 0;
        try {
          navigator.mediaSession.setPositionState?.();
        } catch {
          /* 忽略 */
        }
      },
    };
  }, []);

  // —— 元数据 + 进度复位 ——
  useEffect(() => {
    if (!supportsMediaSession()) return;
    try {
      navigator.mediaSession.metadata = infoKey ? new MediaMetadata(infoRef.current!) : null;
    } catch {
      /* 忽略 */
    }
    // 换片/换集后旧进度不能再显示（新一集 duration 也不一样）
    handle.clearPosition();
  }, [infoKey, handle]);

  // —— 通知栏/锁屏/耳机按键 ——
  useEffect(() => {
    if (!supportsMediaSession()) return;
    const session = navigator.mediaSession;
    const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* Safari 对不支持的 action 会抛 NotSupportedError：不注册就自然不显示按钮 */
      }
    };

    bind('play', () => actionsRef.current.play?.());
    bind('pause', () => actionsRef.current.pause?.());
    if (canSeek) {
      bind('seekto', (details) => {
        if (typeof details.seekTime === 'number') actionsRef.current.seekTo?.(details.seekTime);
      });
      bind('seekbackward', (details) => actionsRef.current.seekBy?.(-(details.seekOffset ?? 10)));
      bind('seekforward', (details) => actionsRef.current.seekBy?.(details.seekOffset ?? 10));
    }
    if (canPrev) bind('previoustrack', () => actionsRef.current.prev?.());
    if (canNext) bind('nexttrack', () => actionsRef.current.next?.());

    return () => {
      bind('play', null);
      bind('pause', null);
      if (canSeek) {
        bind('seekto', null);
        bind('seekbackward', null);
        bind('seekforward', null);
      }
      if (canPrev) bind('previoustrack', null);
      if (canNext) bind('nexttrack', null);
    };
  }, [canSeek, canPrev, canNext]);

  // —— 卸载：清空会话，否则从播放页回首页后通知栏还挂着上一部 ——
  useEffect(
    () => () => {
      if (!supportsMediaSession()) return;
      try {
        const session = navigator.mediaSession;
        session.metadata = null;
        session.playbackState = 'none';
        session.setPositionState?.();
      } catch {
        /* 忽略 */
      }
    },
    []
  );

  return handle;
}
