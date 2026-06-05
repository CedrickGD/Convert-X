/**
 * Shared types for the ClipEditor (v0.5+).
 * Re-export from state/types so consumers can import from one place.
 */
export type { CropSpec as CropRect } from '../../../state/types';
export type RotateDeg = 0 | 90 | 180 | 270;

/** Layout box for the displayed video frame inside its parent (object-fit:contain math). */
export type DisplayRect = { x: number; y: number; w: number; h: number };

export function pctToTime(pct: number, duration: number): number {
  return Math.max(0, Math.min(duration, (pct / 100) * duration));
}
export function timeToPct(t: number, duration: number): number {
  return duration > 0 ? (t / duration) * 100 : 0;
}
export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}
