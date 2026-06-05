import React from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, typography, useTheme } from '../../../theme';

type Props = {
  duration: number;
  trimStart: number;
  trimEnd: number;
  trackWidth: number;
  onTrackWidth: (w: number) => void;
  onTrackTap: (timeSec: number) => void;
  children?: React.ReactNode;
};

/**
 * 36px track with tick labels above, dimmed regions outside the [trimStart,
 * trimEnd] window, and an accent-tinted selection band inside it.
 *
 * Children are rendered absolutely positioned over the track (the parent
 * passes Playhead + TrimHandle here).
 */
export function TimelineTrack({
  duration,
  trimStart,
  trimEnd,
  trackWidth,
  onTrackWidth,
  onTrackTap,
  children,
}: Props) {
  const { theme } = useTheme();
  const ticks = buildTicks(duration);

  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 100;

  const handleLayout = (e: LayoutChangeEvent) => {
    onTrackWidth(e.nativeEvent.layout.width);
  };

  const handleTap = (e: { nativeEvent: { locationX: number } }) => {
    if (trackWidth <= 0 || duration <= 0) return;
    const t = Math.max(0, Math.min(duration, (e.nativeEvent.locationX / trackWidth) * duration));
    const clamped = Math.max(trimStart, Math.min(trimEnd, t));
    onTrackTap(clamped);
  };

  return (
    <View style={styles.wrap}>
      {/* Tick labels above the track */}
      <View style={styles.ticks}>
        {ticks.map((t) => (
          <Text
            key={t}
            style={[
              styles.tickLabel,
              {
                color: theme.text.muted,
                left: `${(t / duration) * 100}%`,
              },
            ]}
          >
            {fmtTickLabel(t)}
          </Text>
        ))}
      </View>

      {/* The track itself */}
      <Pressable onPress={handleTap} style={styles.trackPressable}>
        <View
          onLayout={handleLayout}
          style={[
            styles.track,
            { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
          ]}
        >
          {/* Selection band */}
          <View
            pointerEvents="none"
            style={[
              styles.band,
              {
                left: `${startPct}%`,
                width: `${endPct - startPct}%`,
                backgroundColor: theme.accent.subtle,
                borderColor: theme.accent.primary,
              },
            ]}
          />
          {/* Left dim region */}
          {startPct > 0 ? (
            <View
              pointerEvents="none"
              style={[styles.dim, { left: 0, width: `${startPct}%` }]}
            />
          ) : null}
          {/* Right dim region */}
          {endPct < 100 ? (
            <View
              pointerEvents="none"
              style={[styles.dim, { left: `${endPct}%`, width: `${100 - endPct}%` }]}
            />
          ) : null}
          {/* Playhead + trim handles drawn on top of everything */}
          {children}
        </View>
      </Pressable>
    </View>
  );
}

/** Pick a sensible tick spacing for the given duration. */
function buildTicks(duration: number): number[] {
  if (duration <= 0) return [];
  let step = 60;
  if (duration <= 10) step = 1;
  else if (duration <= 30) step = 5;
  else if (duration <= 120) step = 10;
  else if (duration <= 300) step = 30;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return ticks;
}

function fmtTickLabel(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return s === 0 ? `${m}m` : `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  ticks: { height: 16, position: 'relative' },
  tickLabel: { ...typography.tiny, position: 'absolute', top: 0, transform: [{ translateX: -8 }] },
  trackPressable: { width: '100%' },
  track: {
    height: 36,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    position: 'relative',
  },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderTopWidth: 2,
    borderBottomWidth: 2,
  },
  dim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
});
