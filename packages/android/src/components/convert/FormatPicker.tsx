import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FORMATS, FormatDef, MediaType } from '../../lib/formats';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  /** Source file types so we can highlight which formats are valid targets. */
  sourceTypes: Set<MediaType>;
  selectedFormat: string | null;
  onSelect: (key: string) => void;
  /** Formats that match the source extension — useful for "same format no-op" UI. */
  sourceFormats?: Set<string>;
  hasEdits?: boolean;
};

const CATEGORIES: { key: 'image' | 'video' | 'audio'; label: string }[] = [
  { key: 'image', label: 'IMAGE' },
  { key: 'video', label: 'VIDEO' },
  { key: 'audio', label: 'AUDIO' },
];

/**
 * Port of desktop FormatPicker.svelte.
 *
 * Chip grid grouped by category. Compatible formats use full accent
 * styling; unsupported formats are dimmed; same-format-no-edits uses
 * a dashed border (re-encode is a no-op).
 */
export function FormatPicker({
  sourceTypes,
  selectedFormat,
  onSelect,
  sourceFormats,
  hasEdits,
}: Props) {
  const { theme } = useTheme();

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.label, { color: theme.text.muted }]}>FORMAT</Text>
      {CATEGORIES.map((cat) => {
        const formats = FORMATS.filter(
          (f) => f.category === cat.key && f.accepts.some((t) => sourceTypes.has(t))
        );
        if (formats.length === 0) return null;
        return (
          <View key={cat.key} style={styles.section}>
            <Text style={[styles.sectionLabel, { color: theme.text.muted }]}>
              {cat.label}
            </Text>
            <View style={styles.chips}>
              {formats.map((f) => (
                <FormatChip
                  key={f.key}
                  format={f}
                  selected={selectedFormat === f.key}
                  sameAsSource={sourceFormats?.has(f.key) && !hasEdits}
                  onPress={() => onSelect(f.key)}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function FormatChip({
  format,
  selected,
  sameAsSource,
  onPress,
}: {
  format: FormatDef;
  selected: boolean;
  sameAsSource?: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  const disabled = !format.supported;
  const bg = selected ? theme.accent.primary : theme.bg.secondary;
  const borderColor = selected
    ? theme.accent.primary
    : sameAsSource
    ? theme.border.subtle
    : theme.border.subtle;
  const textColor = selected
    ? theme.accent.onPrimary
    : disabled
    ? theme.text.muted
    : sameAsSource
    ? theme.text.muted
    : theme.text.secondary;

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: bg,
          borderColor,
          borderStyle: sameAsSource && !selected ? 'dashed' : 'solid',
          opacity: disabled ? 0.4 : pressed && !selected ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.chipText, { color: textColor }]}>{format.label}</Text>
      {!format.supported ? (
        <Text style={[styles.soon, { color: theme.text.muted }]}>soon</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.lg,
  },
  label: { ...typography.micro, letterSpacing: 0.6 },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.tiny, letterSpacing: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico },
  chip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  chipText: { ...typography.caption, fontWeight: '600' },
  soon: { ...typography.tiny },
});
