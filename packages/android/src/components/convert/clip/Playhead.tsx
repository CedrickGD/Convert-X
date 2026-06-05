import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../../../theme';

type Props = {
  /** Current playhead time in seconds (driven by the parent / video). */
  time: number;
  duration: number;
  trackWidth: number;
  trimStart: number;
  trimEnd: number;
  /** Throttled live update during drag so the video can scrub. */
  onScrub: (t: number) => void;
  /** Final commit when the user lifts their finger. */
  onCommit: (t: number) => void;
};

const HEAD_W = 3;

export function Playhead({
  time,
  duration,
  trackWidth,
  trimStart,
  trimEnd,
  onScrub,
  onCommit,
}: Props) {
  const { theme } = useTheme();
  const x = useSharedValue(0);
  const startX = useSharedValue(0);
  const dragging = useSharedValue(0);

  // External time → position. Skip while the user is actively dragging.
  useEffect(() => {
    if (trackWidth <= 0 || duration <= 0) return;
    if (dragging.value > 0) return;
    const px = (time / duration) * trackWidth;
    x.value = withTiming(px, { duration: 120 });
  }, [time, duration, trackWidth, dragging, x]);

  const startPx = duration > 0 ? (trimStart / duration) * trackWidth : 0;
  const endPx = duration > 0 ? (trimEnd / duration) * trackWidth : trackWidth;

  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .onStart(() => {
      'worklet';
      dragging.value = 1;
      startX.value = x.value;
    })
    .onUpdate((e) => {
      'worklet';
      const next = Math.max(startPx, Math.min(endPx, startX.value + e.translationX));
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

  const headStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value - HEAD_W / 2 }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        pointerEvents="box-only"
        hitSlop={{ left: 14, right: 14, top: 4, bottom: 4 }}
        style={[styles.head, { backgroundColor: '#fff' }, headStyle]}
      >
        <View style={[styles.cap, { backgroundColor: theme.accent.primary }]} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  head: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: HEAD_W,
    shadowColor: '#fff',
    shadowOpacity: 0.45,
    shadowRadius: 6,
    elevation: 4,
  },
  cap: {
    position: 'absolute',
    top: -3,
    left: -3,
    right: -3,
    height: 6,
    borderRadius: 3,
  },
});
