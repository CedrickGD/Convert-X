import { Image } from 'expo-image';
import { RotateCcw } from 'lucide-react-native';
import React, { useLayoutEffect, useMemo, useState } from 'react';
import {
  LayoutChangeEvent,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { haptics } from '../../lib/haptics';
import type { CropSpec } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

// Driven by Reanimated animated props so the live px readout updates on the UI
// thread without a React re-render per drag frame.
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

type Props = {
  uri: string;
  /** Source pixel dimensions of the image being cropped. */
  imageWidth: number;
  imageHeight: number;
  /** Existing crop to re-open with, in source-pixel coords. null = whole image. */
  initialCrop: CropSpec | null;
  onCancel: () => void;
  onApply: (crop: CropSpec) => void;
};

/** Corner/edge knob size and the minimum crop box edge, in display px. */
const KNOB = 20;
const BAR_LEN = 28;
const BAR_THICK = 6;
const MIN_DISP = 32;
/** Inset around the image so edge/corner handles stay on-screen and tappable. */
const PAD = spacing.giant;
const SCRIM = 'rgba(0, 0, 0, 0.55)';
const GRID = 'rgba(255, 255, 255, 0.4)';

function clamp(v: number, lo: number, hi: number): number {
  'worklet';
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Full-screen free-form crop editor. The image is rendered at its exact aspect
 * ratio (no letterboxing) so the on-screen box maps 1:1 to source pixels via a
 * single scale factor. Drag the body to move, the 4 corners + 4 edges to
 * resize. Mounted on demand by the parent (no `visible` prop) so each open
 * starts fresh.
 */
export function CropEditor({
  uri,
  imageWidth,
  imageHeight,
  initialCrop,
  onCancel,
  onApply,
}: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  // Measured image-area size; the displayed image is fit inside it by aspect.
  const [area, setArea] = useState({ w: 0, h: 0 });
  // Gate the crop overlay until the box geometry has been seeded (effect below).
  // Mounting the gesture/animated subtree only AFTER the shared values hold the
  // real box size avoids a cold-start race: on the very first crop open of a
  // session the rect's animated style would otherwise attach to the initial
  // 0×0 shared values and miss the post-layout seed — leaving a collapsed,
  // undraggable box (corner knobs + edge bars stacked at the origin). It worked
  // on the second open only because the native surfaces were warm by then.
  const [ready, setReady] = useState(false);
  const disp = useMemo(() => {
    const availW = area.w - PAD * 2;
    const availH = area.h - PAD * 2;
    if (availW <= 0 || availH <= 0 || imageWidth <= 0 || imageHeight <= 0) {
      return { w: 0, h: 0 };
    }
    const scale = Math.min(availW / imageWidth, availH / imageHeight);
    return { w: imageWidth * scale, h: imageHeight * scale };
  }, [area, imageWidth, imageHeight]);

  // Crop rect + bounds, all in display px. Driven on the UI thread.
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  const bw = useSharedValue(0);
  const bh = useSharedValue(0);
  const minS = useSharedValue(MIN_DISP);
  // Source pixels per display pixel — lets worklets report the live readout.
  const spd = useSharedValue(1);
  // Gesture start snapshot + active flag (for handle scale-up).
  const sx = useSharedValue(0);
  const sy = useSharedValue(0);
  const sw = useSharedValue(0);
  const sh = useSharedValue(0);
  const active = useSharedValue(0);

  // Initialise / re-fit the box whenever the display size resolves. Runs as a
  // layout effect (before paint) and flips `ready` only after seeding, so the
  // overlay never mounts against un-seeded 0×0 geometry.
  useLayoutEffect(() => {
    if (disp.w <= 0 || disp.h <= 0) {
      setReady(false);
      return;
    }
    const perDisp = imageWidth / disp.w;
    bw.value = disp.w;
    bh.value = disp.h;
    minS.value = Math.min(MIN_DISP, disp.w, disp.h);
    spd.value = perDisp;
    if (initialCrop && initialCrop.w > 0 && initialCrop.h > 0) {
      const dscale = disp.w / imageWidth; // display px per source px
      const nx = clamp(initialCrop.x * dscale, 0, disp.w);
      const ny = clamp(initialCrop.y * dscale, 0, disp.h);
      x.value = nx;
      y.value = ny;
      w.value = clamp(initialCrop.w * dscale, minS.value, disp.w - nx);
      h.value = clamp(initialCrop.h * dscale, minS.value, disp.h - ny);
    } else {
      x.value = 0;
      y.value = 0;
      w.value = disp.w;
      h.value = disp.h;
    }
    setReady(true);
  }, [disp, initialCrop, imageWidth, bw, bh, minS, spd, x, y, w, h]);

  const onArea = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setArea({ w: width, h: height });
  };

  // One gesture builder for body + all 8 handles. Flags say which edges move;
  // body (no flags) translates the whole rect. Reads/writes shared values only,
  // so it never needs rebuilding when layout changes.
  const gestures = useMemo(() => {
    const handle = (moveL: boolean, moveR: boolean, moveT: boolean, moveB: boolean) =>
      Gesture.Pan()
        .onStart(() => {
          'worklet';
          active.value = 1;
          sx.value = x.value;
          sy.value = y.value;
          sw.value = w.value;
          sh.value = h.value;
          runOnJS(haptics.tap)();
        })
        .onUpdate((e) => {
          'worklet';
          let nx = sx.value;
          let ny = sy.value;
          let nw = sw.value;
          let nh = sh.value;
          if (moveL) {
            const right = sx.value + sw.value;
            const left = clamp(sx.value + e.translationX, 0, right - minS.value);
            nx = left;
            nw = right - left;
          }
          if (moveR) {
            const left = moveL ? nx : sx.value;
            const right = clamp(sx.value + sw.value + e.translationX, left + minS.value, bw.value);
            nx = left;
            nw = right - left;
          }
          if (moveT) {
            const bottom = sy.value + sh.value;
            const top = clamp(sy.value + e.translationY, 0, bottom - minS.value);
            ny = top;
            nh = bottom - top;
          }
          if (moveB) {
            const top = moveT ? ny : sy.value;
            const bottom = clamp(sy.value + sh.value + e.translationY, top + minS.value, bh.value);
            ny = top;
            nh = bottom - top;
          }
          x.value = nx;
          y.value = ny;
          w.value = nw;
          h.value = nh;
        })
        .onEnd(() => {
          'worklet';
          active.value = 0;
        });

    const body = Gesture.Pan()
      .onStart(() => {
        'worklet';
        active.value = 1;
        sx.value = x.value;
        sy.value = y.value;
        runOnJS(haptics.tap)();
      })
      .onUpdate((e) => {
        'worklet';
        x.value = clamp(sx.value + e.translationX, 0, bw.value - w.value);
        y.value = clamp(sy.value + e.translationY, 0, bh.value - h.value);
      })
      .onEnd(() => {
        'worklet';
        active.value = 0;
      });

    return {
      body,
      tl: handle(true, false, true, false),
      tr: handle(false, true, true, false),
      bl: handle(true, false, false, true),
      br: handle(false, true, false, true),
      t: handle(false, false, true, false),
      b: handle(false, false, false, true),
      l: handle(true, false, false, false),
      r: handle(false, true, false, false),
    };
    // Built once — reads/writes shared values only (stable refs), so it never
    // needs rebuilding and triggers no React re-renders while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rectStyle = useAnimatedStyle(() => ({
    left: x.value,
    top: y.value,
    width: w.value,
    height: h.value,
  }));
  // Four scrim panels dimming everything outside the crop box.
  const scrimTop = useAnimatedStyle(() => ({ left: 0, top: 0, width: bw.value, height: y.value }));
  const scrimBottom = useAnimatedStyle(() => ({
    left: 0,
    top: y.value + h.value,
    width: bw.value,
    height: Math.max(0, bh.value - (y.value + h.value)),
  }));
  const scrimLeft = useAnimatedStyle(() => ({ left: 0, top: y.value, width: x.value, height: h.value }));
  const scrimRight = useAnimatedStyle(() => ({
    left: x.value + w.value,
    top: y.value,
    width: Math.max(0, bw.value - (x.value + w.value)),
    height: h.value,
  }));

  // Live "W × H px" readout, updated on the UI thread (no React re-render).
  // Before layout resolves (bw === 0) fall back to the full source size so it
  // never flashes "0 × 0".
  const dimsProps = useAnimatedProps(() => {
    const ready = bw.value > 0;
    const sw = ready ? Math.round(w.value * spd.value) : imageWidth;
    const sh = ready ? Math.round(h.value * spd.value) : imageHeight;
    return { text: `${sw} × ${sh} px` } as Partial<React.ComponentProps<typeof TextInput>>;
  });
  // Stable source object so expo-image never reloads on re-render.
  const imageSource = useMemo(() => ({ uri }), [uri]);

  const reset = () => {
    x.value = 0;
    y.value = 0;
    w.value = disp.w;
    h.value = disp.h;
  };

  const apply = () => {
    if (disp.w <= 0) {
      onApply({ x: 0, y: 0, w: imageWidth, h: imageHeight });
      return;
    }
    const perDisp = imageWidth / disp.w;
    const cx = clamp(Math.round(x.value * perDisp), 0, imageWidth - 1);
    const cy = clamp(Math.round(y.value * perDisp), 0, imageHeight - 1);
    const cw = clamp(Math.round(w.value * perDisp), 1, imageWidth - cx);
    const ch = clamp(Math.round(h.value * perDisp), 1, imageHeight - cy);
    onApply({ x: cx, y: cy, w: cw, h: ch });
  };

  const knob = { backgroundColor: theme.accent.primary, borderColor: theme.accent.onPrimary };

  return (
    <Modal
      visible
      transparent={false}
      animationType={reduceMotion ? 'none' : 'slide'}
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <GestureHandlerRootView style={[styles.root, { backgroundColor: theme.bg.base }]}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <Pressable
            onPress={onCancel}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Cancel crop"
            style={styles.headerBtn}
          >
            <Text style={[styles.headerCancel, { color: theme.text.secondary }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.text.primary }]}>Crop</Text>
          <Pressable
            onPress={apply}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Apply crop"
            style={styles.headerBtn}
          >
            <Text style={[styles.headerDone, { color: theme.accent.primary }]}>Done</Text>
          </Pressable>
        </View>

        {/* Image + crop overlay */}
        <View style={styles.area} onLayout={onArea}>
          {ready ? (
            <View style={{ width: disp.w, height: disp.h }}>
              <Image source={imageSource} style={StyleSheet.absoluteFill} contentFit="fill" />

              <Animated.View style={[styles.scrim, scrimTop]} pointerEvents="none" />
              <Animated.View style={[styles.scrim, scrimBottom]} pointerEvents="none" />
              <Animated.View style={[styles.scrim, scrimLeft]} pointerEvents="none" />
              <Animated.View style={[styles.scrim, scrimRight]} pointerEvents="none" />

              <Animated.View style={[styles.rect, rectStyle, { borderColor: theme.accent.primary }]}>
                {/* Rule-of-thirds grid */}
                <View style={[styles.gridV, { left: '33.333%' }]} pointerEvents="none" />
                <View style={[styles.gridV, { left: '66.666%' }]} pointerEvents="none" />
                <View style={[styles.gridH, { top: '33.333%' }]} pointerEvents="none" />
                <View style={[styles.gridH, { top: '66.666%' }]} pointerEvents="none" />

                {/* Drag body */}
                <GestureDetector gesture={gestures.body}>
                  <Animated.View style={StyleSheet.absoluteFill} />
                </GestureDetector>

                {/* Edge handles */}
                <GestureDetector gesture={gestures.t}>
                  <View style={[styles.barH, styles.edgeT, knob]} hitSlop={14} />
                </GestureDetector>
                <GestureDetector gesture={gestures.b}>
                  <View style={[styles.barH, styles.edgeB, knob]} hitSlop={14} />
                </GestureDetector>
                <GestureDetector gesture={gestures.l}>
                  <View style={[styles.barV, styles.edgeL, knob]} hitSlop={14} />
                </GestureDetector>
                <GestureDetector gesture={gestures.r}>
                  <View style={[styles.barV, styles.edgeR, knob]} hitSlop={14} />
                </GestureDetector>

                {/* Corner handles */}
                <GestureDetector gesture={gestures.tl}>
                  <View style={[styles.corner, styles.cTL, knob]} hitSlop={14} />
                </GestureDetector>
                <GestureDetector gesture={gestures.tr}>
                  <View style={[styles.corner, styles.cTR, knob]} hitSlop={14} />
                </GestureDetector>
                <GestureDetector gesture={gestures.bl}>
                  <View style={[styles.corner, styles.cBL, knob]} hitSlop={14} />
                </GestureDetector>
                <GestureDetector gesture={gestures.br}>
                  <View style={[styles.corner, styles.cBR, knob]} hitSlop={14} />
                </GestureDetector>
              </Animated.View>
            </View>
          ) : null}
        </View>

        {/* Footer */}
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={[styles.dimsBadge, { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle }]}>
            <AnimatedTextInput
              editable={false}
              caretHidden
              underlineColorAndroid="transparent"
              defaultValue={`${imageWidth} × ${imageHeight} px`}
              animatedProps={dimsProps}
              style={[styles.dimsText, { color: theme.text.secondary }]}
            />
          </View>
          <Pressable
            onPress={reset}
            accessibilityRole="button"
            accessibilityLabel="Reset crop to full image"
            style={({ pressed }) => [
              styles.resetBtn,
              {
                backgroundColor: pressed ? theme.bg.surfaceHigh : theme.bg.surface,
                borderColor: theme.border.subtle,
              },
            ]}
          >
            <RotateCcw size={15} strokeWidth={2} color={theme.text.secondary} />
            <Text style={[styles.resetText, { color: theme.text.secondary }]}>Reset</Text>
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.huge,
    paddingBottom: spacing.md,
  },
  headerBtn: { minWidth: 60 },
  headerTitle: { ...typography.bodyEmph, fontWeight: '600' },
  headerCancel: { ...typography.body, textAlign: 'left' },
  headerDone: { ...typography.body, fontWeight: '700', textAlign: 'right' },

  area: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrim: { position: 'absolute', backgroundColor: SCRIM },
  rect: {
    position: 'absolute',
    borderWidth: 1.5,
  },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: GRID },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: GRID },

  corner: {
    position: 'absolute',
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    borderWidth: 2,
  },
  cTL: { left: -KNOB / 2, top: -KNOB / 2 },
  cTR: { right: -KNOB / 2, top: -KNOB / 2 },
  cBL: { left: -KNOB / 2, bottom: -KNOB / 2 },
  cBR: { right: -KNOB / 2, bottom: -KNOB / 2 },

  barH: {
    position: 'absolute',
    width: BAR_LEN,
    height: BAR_THICK,
    borderRadius: BAR_THICK / 2,
    marginLeft: -BAR_LEN / 2,
  },
  barV: {
    position: 'absolute',
    width: BAR_THICK,
    height: BAR_LEN,
    borderRadius: BAR_THICK / 2,
    marginTop: -BAR_LEN / 2,
  },
  edgeT: { top: -BAR_THICK / 2, left: '50%' },
  edgeB: { bottom: -BAR_THICK / 2, left: '50%' },
  edgeL: { left: -BAR_THICK / 2, top: '50%' },
  edgeR: { right: -BAR_THICK / 2, top: '50%' },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },
  dimsBadge: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dimsText: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    padding: 0,
    margin: 0,
    includeFontPadding: false,
    minWidth: 110,
    textAlign: 'center',
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetText: { ...typography.caption, fontWeight: '600' },
});
