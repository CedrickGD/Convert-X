import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useConvert, useDownload, useResize, useShared } from '../state';
import { Mode } from '../state/types';
import { elevation, radius, spacing, typography, useTheme } from '../theme';

/**
 * Desktop's Navbar.svelte ported to RN.
 *
 * Flat tab strip — 4 buttons sitting on a recessed `bg.secondary` track.
 * Each tab shows a busy dot when its mode has in-flight work.
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

  return (
    <View
      style={[
        styles.navbar,
        {
          backgroundColor: theme.bg.secondary,
          borderColor: theme.border.subtle,
        },
      ]}
    >
      {TABS.map((tab) => {
        const isActive = activeMode === tab.key;
        const isBusy = busyByMode[tab.key];
        return (
          <Pressable
            key={tab.key}
            onPress={() => switchMode(tab.key)}
            hitSlop={{ top: 8, bottom: 8 }}
            android_ripple={{ color: theme.accent.glow, borderless: false }}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={isBusy ? `${tab.label}, working` : tab.label}
            style={({ pressed }) => [
              styles.tab,
              {
                backgroundColor: isActive ? theme.bg.surface : 'transparent',
                opacity: pressed && !isActive ? 0.7 : 1,
                elevation: isActive ? elevation.low : 0,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.2}
              style={[
                styles.tabLabel,
                { color: isActive ? theme.text.primary : theme.text.muted },
              ]}
            >
              {tab.label}
            </Text>
            {isBusy ? (
              <View style={[styles.busyDot, { backgroundColor: theme.accent.primary }]} />
            ) : null}
          </Pressable>
        );
      })}
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
    // Weight comes from the font family (Inter-SemiBold), not fontWeight — a
    // custom-family + fontWeight combo is a no-op in RN. typography.base is the
    // SemiBold the StyleGuide reference uses, so the live tab now matches it.
    ...typography.base,
  },
  busyDot: {
    // Absolutely positioned so it doesn't shift the centered label when work
    // starts (the in-flow dot used to make the label jitter / shrink).
    position: 'absolute',
    top: 4,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
