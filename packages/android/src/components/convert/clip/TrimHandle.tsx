import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { useTheme } from '../../../theme';

type Props = {
  side: 'start' | 'end';
  /** Current trim point in seconds. */
  time: number;
  /** The OTHER side's trim time — used for min-gap clamping. */
  otherTime: number;
  duration: number;
  trackWidth: number;
  onScrub: (t: number) => void;
  onCommit: (t: number) => void;
};

const HIT_W = 48;
const GRIP_W = 8;
const MIN_GAP_SEC = 0.1;

export function TrimHandle({
  side,
  time,
  otherTime,
  duration,
  trackWidth,
  onScrub,
  onCommit,
}: Props) {
  const { theme } = useTheme();
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
  const dragging = useSharedValue(0);

  useEffect(() => {
    if (duration <= 0 || trackWidth <= 0) return;
    if (dragging.value > 0) return;
    x.value = (time / duration) * trackWidth;
  }, [time, duration, trackWidth, dragging, x]);

  const minPx =
    side === 'start' ? 0 : ((otherTime + MIN_GAP_SEC) / duration) * trackWidth;
  const maxPx =
    side === 'start'
      ? ((otherTime - MIN_GAP_SEC) / duration) * trackWidth
      : trackWidth;

  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .onStart(() => {
      'worklet';
      dragging.value = 1;
      startX.value = x.value;
    })
    .onUpdate((e) => {
      'worklet';
      const next = Math.max(minPx, Math.min(maxPx, startX.value + e.translationX));
      x.value = next;
      if (duration > 0 && trackWidth > 0) {
        const t = (next / trackWidth) * duration;
        runOnJS(onScrub)(t);
      }
    })
    .onEnd(() => {
      'worklet';
      dragging.value = 0;
      if (duration > 0 && trackWidth > 0) {
        const t = (x.value / trackWidth) * duration;
        runOnJS(onCommit)(t);
      }
    });

  const hitStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value - HIT_W / 2 },
      { scale: dragging.value ? 1.1 : 1 },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.hit, hitStyle]}
        hitSlop={{ top: 12, bottom: 12 }}
      >
        <View style={[styles.grip, { backgroundColor: theme.accent.primary }]}>
          <View style={[styles.gripLine, { backgroundColor: theme.accent.onPrimary }]} />
          <View style={[styles.gripLine, { backgroundColor: theme.accent.onPrimary }]} />
          <View style={[styles.gripLine, { backgroundColor: theme.accent.onPrimary }]} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

// Make withSpring happy in case worklet wraps it later.
void withSpring;

const styles = StyleSheet.create({
  hit: {
    position: 'absolute',
    top: -8,
    bottom: -8,
    width: HIT_W,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grip: {
    width: GRIP_W,
    height: 32,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  gripLine: {
    width: 2,
    height: 3,
    borderRadius: 1,
  },
});
