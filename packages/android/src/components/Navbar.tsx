import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useConvert, useDownload, useResize, useShared } from '../state';
import { Mode } from '../state/types';
import { radius, spacing, typography, useTheme } from '../theme';

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
            style={({ pressed }) => [
              styles.tab,
              {
                backgroundColor: isActive ? theme.bg.surface : 'transparent',
                opacity: pressed && !isActive ? 0.7 : 1,
              },
            ]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
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
    ...typography.caption,
    fontWeight: '600',
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
