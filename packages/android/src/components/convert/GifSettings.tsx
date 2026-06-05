import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ConvertSettings } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  settings: ConvertSettings;
  onUpdate: (patch: Partial<ConvertSettings>) => void;
};

// Mirror the defaults applied in ffmpegArgs.buildGifArgs.
const DEFAULTS = { width: 480, fps: 15, colors: 256 };
const WIDTHS = [240, 320, 480, 640];
const FPS = [10, 15, 20, 24];
const COLORS = [64, 128, 256];

/**
 * GIF output controls — width / framerate / palette colors. Until now every
 * GIF export was hard-pinned to the buildGifArgs defaults (480px / 15fps /
 * 256-color) because nothing ever set these. Rendered in ConvertScreen when
 * the target format is GIF; the quality slider is hidden there since the GIF
 * palette pipeline ignores it.
 */
export function GifSettings({ settings, onUpdate }: Props) {
  const { theme } = useTheme();
  const width = settings.gifWidth ?? DEFAULTS.width;
  const fps = settings.gifFps ?? DEFAULTS.fps;
  const colors = settings.gifColors ?? DEFAULTS.colors;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>GIF SETTINGS</Text>

      <Section label={`WIDTH · ${width}px`}>
        {WIDTHS.map((v) => (
          <Chip key={v} label={`${v}`} selected={width === v} onPress={() => onUpdate({ gifWidth: v })} />
        ))}
      </Section>

      <Section label={`FRAMERATE · ${fps} fps`}>
        {FPS.map((v) => (
          <Chip key={v} label={`${v}`} selected={fps === v} onPress={() => onUpdate({ gifFps: v })} />
        ))}
      </Section>

      <Section label={`COLORS · ${colors}`}>
        {COLORS.map((v) => (
          <Chip key={v} label={`${v}`} selected={colors === v} onPress={() => onUpdate({ gifColors: v })} />
        ))}
      </Section>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.subLabel, { color: theme.text.muted }]}>{label}</Text>
      <View style={styles.chipRow}>{children}</View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? theme.accent.primary : theme.bg.secondary,
          borderColor: selected ? theme.accent.primary : theme.border.subtle,
          opacity: pressed && !selected ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: selected ? theme.accent.onPrimary : theme.text.secondary },
        ]}
      >
        {label}
      </Text>
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
  cardLabel: { ...typography.micro, letterSpacing: 0.6 },
  section: { gap: spacing.sm },
  subLabel: { ...typography.micro, letterSpacing: 0.6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico },
  chip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { ...typography.caption, fontWeight: '600' },
});
