import { Image as ImageIcon, Maximize2 } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, typography, useTheme } from '../../theme';
import type { Mode } from '../../state/types';

type Props = {
  /** Which tab this dropzone is inside — Convert or Resize. Tweaks copy/icon. */
  mode: Mode;
  /** Tap the card → open file picker. */
  onPickFiles: () => void;
  /** Tap the secondary action → open gallery picker. */
  onPickFromGallery: () => void;
};

/**
 * Port of desktop Dropzone.svelte.
 *
 * Full-bleed dashed-border card. Centered icon + title + subtitle + two
 * pickers (Files / Gallery). No native drag-drop on mobile — tap-to-pick.
 * Share-intent receive is wired separately and lands files directly into
 * the mode's state without going through this component.
 */
export function Dropzone({ mode, onPickFiles, onPickFromGallery }: Props) {
  const { theme } = useTheme();
  const isResize = mode === 'resize';

  return (
    <Pressable
      onPress={onPickFiles}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: pressed ? theme.accent.dim : theme.border.hover,
          backgroundColor: theme.bg.secondary,
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: theme.accent.subtle }]}>
        {isResize ? (
          <Maximize2 size={28} strokeWidth={1.6} color={theme.accent.primary} />
        ) : (
          <ImageIcon size={28} strokeWidth={1.6} color={theme.accent.primary} />
        )}
      </View>

      <Text style={[styles.title, { color: theme.text.primary }]}>
        {isResize ? 'Drop images to resize' : 'Drop files to convert'}
      </Text>

      <Text style={[styles.sub, { color: theme.text.muted }]}>
        or tap to browse · PNG · JPG · WebP today
      </Text>

      <View style={styles.chipRow}>
        <View style={[styles.chip, { borderColor: theme.border.subtle }]}>
          <Text style={[styles.chipText, { color: theme.text.muted }]}>PNG</Text>
        </View>
        <View style={[styles.chip, { borderColor: theme.border.subtle }]}>
          <Text style={[styles.chipText, { color: theme.text.muted }]}>JPG</Text>
        </View>
        <View style={[styles.chip, { borderColor: theme.border.subtle }]}>
          <Text style={[styles.chipText, { color: theme.text.muted }]}>WebP</Text>
        </View>
      </View>

      <View style={styles.actionsRow}>
        <Pressable
          onPress={onPickFiles}
          style={({ pressed }) => [
            styles.secondaryBtn,
            {
              borderColor: theme.border.subtle,
              backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
            },
          ]}
        >
          <Text style={[styles.secondaryBtnText, { color: theme.text.secondary }]}>
            Files
          </Text>
        </Pressable>
        <Pressable
          onPress={onPickFromGallery}
          style={({ pressed }) => [
            styles.secondaryBtn,
            {
              borderColor: theme.border.subtle,
              backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
            },
          ]}
        >
          <Text style={[styles.secondaryBtnText, { color: theme.text.secondary }]}>
            Gallery
          </Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingVertical: 56,
    paddingHorizontal: spacing.huge,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    gap: spacing.lg,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.bodyLg, textAlign: 'center' },
  sub: { ...typography.caption, textAlign: 'center' },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { ...typography.micro },
  actionsRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  secondaryBtn: {
    paddingHorizontal: spacing.giant,
    paddingVertical: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  secondaryBtnText: { ...typography.body, fontWeight: '600' },
});
