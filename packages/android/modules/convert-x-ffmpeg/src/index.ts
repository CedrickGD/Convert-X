import { EventSubscription, requireNativeModule } from 'expo-modules-core';

/**
 * Native FFmpeg bridge — thin wrapper over the Maven-published ffmpeg-kit fork.
 *
 * Phase 4: image+video+audio conversion paths route through this module.
 */

type ConvertXFfmpegEvents = {
  onProgress: (event: ProgressEvent) => void;
};

export type ProgressEvent = {
  sessionId: string;
  /** 0..100 — derived from `time` / `duration` when available. */
  percent: number;
  /** Milliseconds processed so far. */
  timeMs: number;
  /** Source duration in milliseconds (probed before run). */
  durationMs: number;
};

export type MediaInfo = {
  durationMs: number;
  width?: number;
  height?: number;
  bitrate?: number;
  codec?: string;
  format?: string;
};

interface NativeModule {
  executeAsync(sessionId: string, args: string[], durationMs: number): Promise<{ returnCode: number; logs: string }>;
  cancel(sessionId: string): void;
  getMediaInfo(uri: string): Promise<MediaInfo>;
  /** Device ABI preference list — used by the updater to pick a matching APK asset. */
  getSupportedAbis(): Promise<string[]>;
  /** Triggers Android's "Install this app?" sheet for a downloaded APK file URI. */
  installApk(uri: string): Promise<void>;
  addListener(eventName: keyof ConvertXFfmpegEvents): void;
  removeListeners(count: number): void;
}

const native = requireNativeModule<NativeModule>('ConvertXFfmpeg');

export function executeAsync(
  sessionId: string,
  args: string[],
  durationMs: number
): Promise<{ returnCode: number; logs: string }> {
  return native.executeAsync(sessionId, args, durationMs);
}

export function cancel(sessionId: string): void {
  native.cancel(sessionId);
}

export function getMediaInfo(uri: string): Promise<MediaInfo> {
  return native.getMediaInfo(uri);
}

export function getSupportedAbis(): Promise<string[]> {
  return native.getSupportedAbis();
}

export function installApk(uri: string): Promise<void> {
  return native.installApk(uri);
}

export function addProgressListener(
  cb: (event: ProgressEvent) => void
): EventSubscription {
  // expo-modules-core's EventEmitter is bound onto the native module by default
  // — `addListener` on the native side just registers an event name; the JS
  // event-emitter portion is handled internally.
  const emitter = (native as unknown as {
    addListener: (
      name: 'onProgress',
      listener: (e: ProgressEvent) => void
    ) => EventSubscription;
  });
  return emitter.addListener('onProgress', cb);
}
