import { Crop, X } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CropSpec } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  crop: CropSpec | null;
  onEdit: () => void;
  onClear: () => void;
};

/**
 * Crop trigger for the Resize screen (single image only). With no crop it's a
 * single "Crop image" button; once a crop exists it shows the cropped size
 * with Edit / Clear. The actual framing happens in <CropEditor>.
 */
export function CropControl({ crop, onEdit, onClear }: Props) {
  const { theme } = useTheme();

  if (!crop) {
    return (
      <Pressable
        onPress={onEdit}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: pressed ? theme.bg.surfaceHigh : theme.bg.surface,
            borderColor: theme.border.subtle,
          },
        ]}
      >
        <Crop size={16} strokeWidth={2} color={theme.text.secondary} />
        <Text style={[styles.buttonText, { color: theme.text.primary }]}>Crop image</Text>
      </Pressable>
    );
  }

  return (
    <View
      style={[
        styles.active,
        { backgroundColor: theme.accent.subtle, borderColor: theme.accent.dim },
      ]}
    >
      <Crop size={16} strokeWidth={2} color={theme.accent.primary} />
      <View style={styles.activeMeta}>
        <Text style={[styles.activeTitle, { color: theme.text.primary }]}>Cropped</Text>
        <Text style={[styles.activeDims, { color: theme.text.secondary }]}>
          {crop.w} × {crop.h} px
        </Text>
      </View>
      <Pressable
        onPress={onEdit}
        style={({ pressed }) => [
          styles.editBtn,
          { borderColor: theme.accent.dim, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.editText, { color: theme.accent.primary }]}>Edit</Text>
      </Pressable>
      <Pressable onPress={onClear} hitSlop={8} style={styles.clearBtn}>
        <X size={16} strokeWidth={2} color={theme.text.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonText: { ...typography.body, fontWeight: '600' },

  active: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  activeMeta: { flex: 1 },
  activeTitle: { ...typography.bodySm, fontWeight: '600' },
  activeDims: { ...typography.caption, fontVariant: ['tabular-nums'], marginTop: 1 },
  editBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  editText: { ...typography.caption, fontWeight: '700' },
  clearBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
