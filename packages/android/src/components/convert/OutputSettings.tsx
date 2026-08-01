import React, { useEffect, useState } from 'react';
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
  /** Hide the quality slider (e.g. GIF, whose palette pipeline ignores it). */
  showQuality?: boolean;

  /** Target output size in MB. null = off (quality slider drives the encode). */
  targetSizeMb?: number | null;
  onTargetSizeChange?: (mb: number | null) => void;
  /** Show the target-size field — video targets only. */
  showTargetSize?: boolean;
};

/** Empty / zero / garbage all mean "off" — the field can never hard-error. */
function parseTargetSize(text: string): number | null {
  // Accept a decimal comma (German locale keyboards emit one).
  const n = parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
  showQuality = true,
  targetSizeMb,
  onTargetSizeChange,
  showTargetSize = false,
}: Props) {
  const { theme } = useTheme();
  const copy = QUALITY_KIND_COPY[qualityKind] ?? QUALITY_KIND_COPY.image;

  // The field owns its raw text so partial input ("1." / "0,") survives the
  // controlled round-trip; only the parsed value goes up to settings.
  const [sizeText, setSizeText] = useState(
    targetSizeMb != null ? String(targetSizeMb) : ''
  );
  useEffect(() => {
    // External change (reset, hydration) — re-sync unless the text already
    // parses to the incoming value, which would clobber in-progress typing.
    if ((targetSizeMb ?? null) !== parseTargetSize(sizeText)) {
      setSizeText(targetSizeMb != null ? String(targetSizeMb) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSizeMb]);

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

      {showQuality ? (
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
      ) : null}

      {showTargetSize && onTargetSizeChange ? (
        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.text.muted }]}>TARGET SIZE</Text>
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
              value={sizeText}
              onChangeText={(text) => {
                setSizeText(text);
                onTargetSizeChange(parseTargetSize(text));
              }}
              placeholder="Off"
              placeholderTextColor={theme.text.muted}
              keyboardType="decimal-pad"
              style={[styles.nameInput, { color: theme.text.primary }]}
            />
            <Text style={[styles.ext, { color: theme.accent.primary }]}>MB</Text>
          </View>
          <Text style={[styles.sliderLabel, { color: theme.text.muted }]}>
            Fits the export under this size by overriding the quality slider.
            Leave empty to disable.
          </Text>
        </View>
      ) : null}
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
