import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Slider } from '../Slider';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  /** Show a filename input if this is a single-file conversion. */
  singleFileName?: string;
  /** Target format extension to show as a trailing badge after the filename. */
  formatExt?: string;
  onFilenameChange?: (name: string) => void;

  quality: number;
  onQualityChange: (q: number) => void;
  qualityKind?: 'image' | 'video' | 'audio';
};

const QUALITY_KIND_COPY: Record<string, { label: string; hi: string }> = {
  image: { label: 'Image quality', hi: 'Sharper' },
  video: { label: 'Bitrate quality', hi: 'Higher bitrate' },
  audio: { label: 'Audio quality', hi: 'Higher bitrate' },
};

/**
 * Port of desktop OutputSettings.svelte.
 *
 * Filename input (single-file mode only) + quality slider with low/high
 * end-labels. Mobile drops desktop's output-directory picker — the export
 * goes to Convert-X gallery album / share intent.
 */
export function OutputSettings({
  singleFileName,
  formatExt,
  onFilenameChange,
  quality,
  onQualityChange,
  qualityKind = 'image',
}: Props) {
  const { theme } = useTheme();
  const copy = QUALITY_KIND_COPY[qualityKind] ?? QUALITY_KIND_COPY.image;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      {singleFileName !== undefined ? (
        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.text.muted }]}>FILE NAME</Text>
          <View
            style={[
              styles.nameRow,
              {
                backgroundColor: theme.bg.surfaceSunken,
                borderColor: theme.border.subtle,
              },
            ]}
          >
            <TextInput
              value={singleFileName}
              onChangeText={onFilenameChange}
              placeholder="output"
              placeholderTextColor={theme.text.muted}
              style={[styles.nameInput, { color: theme.text.primary }]}
            />
            {formatExt ? (
              <Text style={[styles.ext, { color: theme.accent.primary }]}>.{formatExt}</Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={styles.field}>
        <Slider
          value={quality}
          onChange={onQualityChange}
          min={1}
          max={100}
          step={1}
          label={copy.label}
          suffix="%"
        />
        <View style={styles.sliderLabels}>
          <Text style={[styles.sliderLabel, { color: theme.text.muted }]}>Smaller</Text>
          <Text style={[styles.sliderLabel, { color: theme.text.muted }]}>{copy.hi}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.lg,
  },
  field: { gap: spacing.sm },
  label: { ...typography.micro, letterSpacing: 0.6 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
  nameInput: {
    flex: 1,
    ...typography.bodySm,
    paddingVertical: 0,
  },
  ext: { ...typography.bodySm, fontWeight: '600' },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sliderLabel: { ...typography.tiny },
});
