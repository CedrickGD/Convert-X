import React, { useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';

import { useConvert, useDownload, useResize, useShared } from '../state';
import { Mode } from '../state/types';
import { elevation, motion, radius, spacing, typography, useTheme } from '../theme';

/**
 * Desktop's Navbar.svelte ported to RN.
 *
 * Flat tab strip — 4 buttons on a recessed track with a single sliding
 * indicator that eases between tabs (instead of the active background
 * hard-cutting from one tab to the next). Each tab shows a busy dot when
 * its mode has in-flight work.
 */
const TABS: { key: Mode; label: string }[] = [
  { key: 'convert', label: 'Convert' },
  { key: 'resize', label: 'Resize' },
  { key: 'download', label: 'Download' },
  { key: 'credits', label: 'Credits' },
];

export function Navbar() {
  const { theme } = useTheme();
  const { activeMode, switchMode } = useShared();
  const { busy: convertBusy } = useConvert();
  const { busy: resizeBusy } = useResize();
  const { busy: downloadBusy } = useDownload();

  const busyByMode: Record<Mode, boolean> = {
    convert: convertBusy,
    resize: resizeBusy,
    download: downloadBusy,
    credits: false,
  };

  // Measured layout of each tab (x + width), keyed by index. The sliding
  // indicator reads these so it lands exactly on the active tab regardless
  // of label width or locale.
  const [tabLayouts, setTabLayouts] = useState<Record<number, { x: number; width: number }>>({});
  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);

  const activeIndex = TABS.findIndex((t) => t.key === activeMode);

  // Drive the indicator whenever the active tab or its measured layout changes.
  React.useEffect(() => {
    const layout = tabLayouts[activeIndex];
    if (!layout) return;
    const easing = Easing.bezier(...motion.bezier.standard);
    // First placement (width 0) snaps; subsequent moves ease.
    const duration = indicatorW.value === 0 ? 0 : motion.timing.base;
    indicatorX.value = withTiming(layout.x, { duration, easing });
    indicatorW.value = withTiming(layout.width, { duration, easing });
  }, [activeIndex, tabLayouts, indicatorX, indicatorW]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorW.value,
  }));

  const onTabLayout = (index: number) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setTabLayouts((prev) => {
      const cur = prev[index];
      if (cur && cur.x === x && cur.width === width) return prev;
      return { ...prev, [index]: { x, width } };
    });
  };

  return (
    <View
      // Scheme-keyed remount preserves the v0.7.0 fix for the stale active
      // pill under Fabric on a dark/light toggle. A toggle snaps the
      // indicator (re-measure); tab switches within a theme still animate.
      key={theme.isDark ? 'dark' : 'light'}
      style={[
        styles.navbar,
        {
          backgroundColor: theme.bg.secondary,
          borderColor: theme.border.subtle,
        },
      ]}
    >
      {/* Sliding active-tab indicator — sits under the labels. */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.indicator,
          {
            backgroundColor: theme.bg.surface,
            elevation: elevation.low,
          },
          indicatorStyle,
        ]}
      />
      {TABS.map((tab, index) => {
        const isActive = activeMode === tab.key;
        const isBusy = busyByMode[tab.key];
        return (
          <Pressable
            key={tab.key}
            onLayout={onTabLayout(index)}
            onPress={() => switchMode(tab.key)}
            hitSlop={{ top: 8, bottom: 8 }}
            android_ripple={{ color: theme.accent.glow, borderless: false }}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={isBusy ? `${tab.label}, working` : tab.label}
            style={styles.tab}
          >
            <TabLabel active={isActive} label={tab.label} theme={theme} />
            {isBusy ? (
              <View style={[styles.busyDot, { backgroundColor: theme.accent.primary }]} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Label whose color cross-fades between muted and primary as the tab
 * activates, so the text doesn't hard-flip in sync with the sliding pill.
 */
function TabLabel({
  active,
  label,
  theme,
}: {
  active: boolean;
  label: string;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  const t = useSharedValue(active ? 1 : 0);
  React.useEffect(() => {
    t.value = withTiming(active ? 1 : 0, {
      duration: motion.timing.base,
      easing: Easing.bezier(...motion.bezier.standard),
    });
  }, [active, t]);

  // Reanimated can't interpolate arbitrary theme hex on the JS thread here
  // cheaply, so cross-fade two stacked labels: muted underneath, primary on
  // top fading in. Same layout, no reflow.
  const topStyle = useAnimatedStyle(() => ({ opacity: t.value }));
  return (
    <View>
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
        style={[styles.tabLabel, { color: theme.text.muted }]}
      >
        {label}
      </Text>
      <Animated.Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
        style={[styles.tabLabel, styles.tabLabelTop, { color: theme.text.primary }, topStyle]}
      >
        {label}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  navbar: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
  },
  indicator: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 0,
    borderRadius: radius.xs + 1,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: spacing.md,
    paddingHorizontal: 2,
    borderRadius: radius.xs + 1,
  },
  tabLabel: {
    // Weight comes from the font family (Inter-SemiBold), not fontWeight.
    ...typography.base,
  },
  tabLabelTop: {
    ...StyleSheet.absoluteFillObject,
  },
  busyDot: {
    position: 'absolute',
    top: 4,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
