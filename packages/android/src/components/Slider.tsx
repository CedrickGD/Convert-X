import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { haptics } from '../lib/haptics';
import { motion, radius, spacing, typography, useTheme } from '../theme';

type Props = {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
  suffix?: string;
  /** Format the displayed value. Defaults to Math.round + suffix. */
  formatValue?: (value: number) => string;
};

const THUMB_SIZE = 20;
const TRACK_HEIGHT = 3;

/**
 * Custom pan-gesture slider. Bubble appears above the thumb while dragging.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  suffix = '',
  formatValue,
}: Props) {
  const { theme } = useTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  const pressed = useSharedValue(0);

  const range = Math.max(1, max - min);
  const ratio = Math.min(1, Math.max(0, (value - min) / range));
  const thumbX = useSharedValue(ratio * Math.max(0, trackWidth - THUMB_SIZE));

  // Sync external value → shared value when `value` / `trackWidth` change from outside.
  React.useEffect(() => {
    if (trackWidth <= 0) return;
    thumbX.value = withSpring(
      ratio * Math.max(0, trackWidth - THUMB_SIZE),
      motion.spring.snappy
    );
  }, [ratio, trackWidth, thumbX]);

  const formatted =
    formatValue?.(value) ??
    `${Math.round(value)}${suffix}`;

  const commit = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, next));
      const stepped = Math.round(clamped / step) * step;
      const rounded = Math.max(min, Math.min(max, stepped));
      if (rounded !== value) {
        onChange(rounded);
      }
    },
    [max, min, onChange, step, value]
  );

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      pressed.value = withSpring(1, motion.spring.snappy);
      runOnJS(haptics.tap)();
    })
    .onChange((e) => {
      if (trackWidth <= 0) return;
      const usable = Math.max(1, trackWidth - THUMB_SIZE);
      const nextX = Math.min(usable, Math.max(0, thumbX.value + e.changeX));
      thumbX.value = nextX;
      const rawValue = min + (nextX / usable) * range;
      runOnJS(commit)(rawValue);
    })
    .onFinalize(() => {
      pressed.value = withTiming(0, { duration: motion.timing.fast });
    });

  const tap = Gesture.Tap()
    .maxDuration(250)
    .onEnd((e) => {
      if (trackWidth <= 0) return;
      const usable = Math.max(1, trackWidth - THUMB_SIZE);
      const nextX = Math.min(usable, Math.max(0, e.x - THUMB_SIZE / 2));
      thumbX.value = withSpring(nextX, motion.spring.snappy);
      const rawValue = min + (nextX / usable) * range;
      runOnJS(commit)(rawValue);
      runOnJS(haptics.pick)();
    });

  const composed = Gesture.Simultaneous(pan, tap);

  const handleLayout = (event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: thumbX.value },
      { scale: 1 + pressed.value * 0.15 },
    ],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: thumbX.value + THUMB_SIZE / 2,
  }));

  const bubbleStyle = useAnimatedStyle(() => ({
    opacity: pressed.value,
    transform: [
      { translateX: thumbX.value - 8 },
      { translateY: -pressed.value * 4 },
      { scale: 0.9 + pressed.value * 0.1 },
    ],
  }));

  return (
    <View style={styles.container}>
      {label ? (
        <View style={styles.labelRow}>
          <Text style={[styles.label, { color: theme.text.secondary }]}>{label}</Text>
          <Text style={[styles.value, { color: theme.text.primary }]}>{formatted}</Text>
        </View>
      ) : null}
      <GestureDetector gesture={composed}>
        <View style={styles.trackWrap}>
          <View
            onLayout={handleLayout}
            style={[
              styles.track,
              {
                backgroundColor: theme.bg.surfaceSunken,
                borderColor: theme.border.subtle,
              },
            ]}
          >
            <Animated.View style={[styles.fill, fillStyle]}>
              <LinearGradient
                colors={theme.accent.gradient as unknown as readonly [string, string]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          </View>
          <Animated.View
            style={[
              styles.thumb,
              {
                backgroundColor: theme.bg.surface,
                borderColor: theme.accent.primary,
                shadowColor: theme.accent.primaryGlow,
              },
              thumbStyle,
            ]}
            pointerEvents="none"
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.bubble,
              {
                backgroundColor: theme.accent.primary,
              },
              bubbleStyle,
            ]}
          >
            <Text style={[styles.bubbleText, { color: theme.text.onAccent }]}>
              {formatted}
            </Text>
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  label: {
    ...typography.bodyEmph,
  },
  value: {
    ...typography.bodyEmph,
  },
  trackWrap: {
    height: THUMB_SIZE + spacing.md,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    borderRadius: TRACK_HEIGHT / 2,
    overflow: 'hidden',
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    borderWidth: 2,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  bubble: {
    position: 'absolute',
    bottom: THUMB_SIZE + spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderRadius: radius.sm,
    minWidth: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleText: {
    ...typography.micro,
  },
});
