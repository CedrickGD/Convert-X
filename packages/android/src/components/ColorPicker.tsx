import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { hexToHsv, hsvToHex } from '../lib/color';
import { haptics } from '../lib/haptics';
import { radius, spacing, useTheme } from '../theme';

const SV_HEIGHT = 150;
const HUE_HEIGHT = 14;
const SV_THUMB = 22;
const HUE_THUMB = 22;

// Even rainbow around the hue wheel. interpolateColor (SV background) and the
// hue track LinearGradient share the same stops so they stay in agreement.
const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360];
const HUE_COLORS = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'];
const HUE_LOCATIONS = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];

type Props = {
  /** Current color as a hex string, e.g. "#7c3aed". */
  value: string;
  /** Fires continuously while dragging — re-theme live, don't persist. */
  onPreview: (hex: string) => void;
  /** Fires once when a gesture settles — persist this value. */
  onCommit: (hex: string) => void;
};

/**
 * Saturation/brightness square + hue slider, in the same pan-gesture idiom as
 * Slider.tsx. HSV lives in shared values (UI thread) for smooth dragging; the
 * resolved hex is handed back to JS via runOnJS.
 */
export function ColorPicker({ value, onPreview, onCommit }: Props) {
  const { theme } = useTheme();
  const [svW, setSvW] = useState(0);
  const [hueW, setHueW] = useState(0);

  const start = hexToHsv(value) ?? { h: 160, s: 0.8, v: 0.7 };
  const hue = useSharedValue(start.h);
  const sat = useSharedValue(start.s);
  const val = useSharedValue(start.v);

  // The last hex we emitted. Used to (a) dedupe preview spam and (b) ignore the
  // parent echoing our own value back so the sync effect doesn't fight a drag.
  const lastHex = useRef<string>(value);

  const emit = useCallback(
    (h: number, s: number, v: number, commit: boolean) => {
      const hex = hsvToHex(h, s, v);
      if (commit) {
        lastHex.current = hex;
        onCommit(hex);
      } else if (hex !== lastHex.current) {
        lastHex.current = hex;
        onPreview(hex);
      }
    },
    [onCommit, onPreview]
  );

  // External value change (preset tap, reset, typed hex) → move the thumbs.
  // Skip our own preview echoes (value === lastHex) to avoid a feedback loop.
  useEffect(() => {
    if (value === lastHex.current) return;
    const hsv = hexToHsv(value);
    if (!hsv) return;
    hue.value = hsv.h;
    sat.value = hsv.s;
    val.value = hsv.v;
    lastHex.current = value;
  }, [value, hue, sat, val]);

  const svPan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      runOnJS(haptics.tap)();
      if (svW <= 0) return;
      const s = clamp01(e.x / svW);
      const v = 1 - clamp01(e.y / SV_HEIGHT);
      sat.value = s;
      val.value = v;
      runOnJS(emit)(hue.value, s, v, false);
    })
    .onChange((e) => {
      if (svW <= 0) return;
      const s = clamp01(e.x / svW);
      const v = 1 - clamp01(e.y / SV_HEIGHT);
      sat.value = s;
      val.value = v;
      runOnJS(emit)(hue.value, s, v, false);
    })
    .onFinalize(() => {
      runOnJS(emit)(hue.value, sat.value, val.value, true);
    });

  const huePan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      runOnJS(haptics.tap)();
      if (hueW <= 0) return;
      const h = clamp01(e.x / hueW) * 360;
      hue.value = h;
      runOnJS(emit)(h, sat.value, val.value, false);
    })
    .onChange((e) => {
      if (hueW <= 0) return;
      const h = clamp01(e.x / hueW) * 360;
      hue.value = h;
      runOnJS(emit)(h, sat.value, val.value, false);
    })
    .onFinalize(() => {
      runOnJS(emit)(hue.value, sat.value, val.value, true);
    });

  const svBg = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(hue.value, HUE_STOPS, HUE_COLORS),
  }));
  const svThumb = useAnimatedStyle(() => ({
    transform: [
      { translateX: sat.value * svW - SV_THUMB / 2 },
      { translateY: (1 - val.value) * SV_HEIGHT - SV_THUMB / 2 },
    ],
  }));
  const hueThumb = useAnimatedStyle(() => ({
    transform: [{ translateX: (hue.value / 360) * hueW - HUE_THUMB / 2 }],
  }));

  return (
    <View style={styles.container}>
      <GestureDetector gesture={svPan}>
        <View
          onLayout={(e: LayoutChangeEvent) => setSvW(e.nativeEvent.layout.width)}
          style={styles.svWrap}
        >
          <Animated.View style={[styles.svSquare, { borderColor: theme.border.subtle }, svBg]}>
            <LinearGradient
              colors={['#ffffff', 'rgba(255,255,255,0)'] as const}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <LinearGradient
              colors={['rgba(0,0,0,0)', '#000000'] as const}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
          </Animated.View>
          <Animated.View style={[styles.svThumb, svThumb]} pointerEvents="none" />
        </View>
      </GestureDetector>

      <GestureDetector gesture={huePan}>
        <View
          onLayout={(e: LayoutChangeEvent) => setHueW(e.nativeEvent.layout.width)}
          style={styles.hueTrackWrap}
        >
          <LinearGradient
            colors={HUE_COLORS as unknown as readonly [string, string, ...string[]]}
            locations={HUE_LOCATIONS as unknown as readonly [number, number, ...number[]]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={[styles.hueTrack, { borderColor: theme.border.subtle }]}
          />
          <Animated.View style={[styles.hueThumb, hueThumb]} pointerEvents="none" />
        </View>
      </GestureDetector>
    </View>
  );
}

function clamp01(n: number): number {
  'worklet';
  return Math.min(1, Math.max(0, n));
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  svWrap: {
    height: SV_HEIGHT,
    justifyContent: 'flex-start',
  },
  svSquare: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  svThumb: {
    position: 'absolute',
    width: SV_THUMB,
    height: SV_THUMB,
    borderRadius: SV_THUMB / 2,
    borderWidth: 3,
    borderColor: '#ffffff',
    backgroundColor: 'transparent',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 2,
    elevation: 3,
  },
  hueTrackWrap: {
    height: HUE_THUMB,
    justifyContent: 'center',
  },
  hueTrack: {
    height: HUE_HEIGHT,
    borderRadius: HUE_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hueThumb: {
    position: 'absolute',
    width: HUE_THUMB,
    height: HUE_THUMB,
    borderRadius: HUE_THUMB / 2,
    borderWidth: 3,
    borderColor: '#ffffff',
    backgroundColor: 'transparent',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 2,
    elevation: 3,
  },
});
