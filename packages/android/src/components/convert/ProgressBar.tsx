import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  /** 0..100 */
  progress: number;
  /** "00:42" or similar — shown muted in the footer. */
  elapsed?: string;
  /** Headline above the percentage. */
  label?: string;
};

/**
 * Port of desktop ProgressBar.svelte.
 *
 * 6px track, accent fill, a shimmer glow that pulses across the fill
 * to telegraph "still working". Percentage in hero typography.
 */
export function ProgressBar({ progress, elapsed, label = 'Converting…' }: Props) {
  const { theme } = useTheme();
  const shimmer = useSharedValue(0);

  useEffect(() => {
    shimmer.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
    return () => cancelAnimation(shimmer);
  }, [shimmer]);

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + shimmer.value * 0.6,
  }));

  const clamped = Math.max(0, Math.min(100, progress));

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.label, { color: theme.text.secondary }]}>{label}</Text>
        {elapsed ? (
          <Text style={[styles.elapsed, { color: theme.text.muted }]}>{elapsed}</Text>
        ) : null}
      </View>
      <Text style={[styles.pct, { color: theme.text.primary }]}>{Math.round(clamped)}%</Text>
      <View style={[styles.track, { backgroundColor: theme.bg.surfaceSunken }]}>
        <Animated.View
          style={[
            styles.fill,
            { backgroundColor: theme.accent.primary, width: `${clamped}%` },
            shimmerStyle,
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.huge,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: { ...typography.body },
  elapsed: { ...typography.caption },
  pct: { ...typography.hero },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  fill: { height: 6, borderRadius: 3 },
});
