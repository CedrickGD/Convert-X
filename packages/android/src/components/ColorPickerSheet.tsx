import { LinearGradient } from 'expo-linear-gradient';
import { Check, X } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, typography, useTheme } from '../theme';
import { GradientButton } from './GradientButton';
import { PressableScale } from './PressableScale';
import { Slider } from './Slider';

type Props = {
  onDone: () => void;
};

// Produce hex color from HSL (lightness fixed at 50 for a vivid preview).
function hslHex(h: number, s: number, l = 50): string {
  const sPct = s / 100;
  const lPct = l / 100;
  const c = (1 - Math.abs(2 * lPct - 1)) * sPct;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lPct - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Modal sheet for custom color picking. Rainbow hue slider + saturation slider,
 * live preview circle, commit button.
 */
export function ColorPickerSheet({ onDone }: Props) {
  const { theme, settings, setCustomHue, setCustomSaturation } = useTheme();
  const insets = useSafeAreaInsets();
  const [hue, setHue] = useState<number>(settings.customHue);
  const [saturation, setSaturation] = useState<number>(settings.customSaturation);

  // Pre-compute the rainbow stops for the hue slider background.
  const rainbowStops = useMemo(() => {
    const steps = 12;
    return Array.from({ length: steps + 1 }, (_, i) => hslHex((i / steps) * 360, saturation, 50));
  }, [saturation]);

  const preview = hslHex(hue, saturation, 50);

  const handleUse = () => {
    setCustomHue(hue);
    setCustomSaturation(saturation);
    onDone();
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg.base }]}>
      <View
        style={[
          styles.handleWrap,
          {
            paddingTop: insets.top + spacing.sm,
          },
        ]}
      >
        <View style={[styles.handle, { backgroundColor: theme.border.strong }]} />
      </View>

      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: theme.text.primary }]}>Custom color</Text>
          <Text style={[styles.caption, { color: theme.text.tertiary }]}>
            Slide to dial in your accent.
          </Text>
        </View>
        <PressableScale
          onPress={onDone}
          hapticType="tap"
          pressedScale={0.9}
          style={[
            styles.closeBtn,
            { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
          ]}
        >
          <X size={18} strokeWidth={1.8} color={theme.text.secondary} />
        </PressableScale>
      </View>

      <View style={styles.body}>
        <View style={styles.previewRow}>
          <View
            style={[
              styles.preview,
              {
                backgroundColor: preview,
                borderColor: theme.border.strong,
              },
            ]}
          >
            <Check size={28} strokeWidth={2.2} color="#ffffff" />
          </View>
          <View style={styles.previewInfo}>
            <Text style={[styles.label, { color: theme.text.tertiary }]}>Preview</Text>
            <Text style={[styles.hex, { color: theme.text.primary }]}>{preview}</Text>
            <Text style={[styles.caption, { color: theme.text.tertiary }]}>
              hsl({Math.round(hue)}, {Math.round(saturation)}%, 50%)
            </Text>
          </View>
        </View>

        <View style={styles.sliderGroup}>
          <View
            pointerEvents="none"
            style={[
              styles.rainbow,
              { borderColor: theme.border.subtle, backgroundColor: theme.bg.surfaceSunken },
            ]}
          >
            <LinearGradient
              colors={rainbowStops as unknown as readonly [string, string, ...string[]]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </View>
          <Slider
            label="Hue"
            value={hue}
            onChange={setHue}
            min={0}
            max={360}
            step={1}
            suffix="°"
          />
        </View>

        <Slider
          label="Saturation"
          value={saturation}
          onChange={setSaturation}
          min={20}
          max={100}
          step={1}
          suffix="%"
        />
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <GradientButton onPress={handleUse} leading={<Check size={18} strokeWidth={2} color={theme.text.onAccent} />}>
          Use this color
        </GradientButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  handleWrap: {
    alignItems: 'center',
    paddingBottom: spacing.sm,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: radius.round,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  title: {
    ...typography.title,
  },
  caption: {
    ...typography.caption,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    gap: spacing.xl,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  preview: {
    width: 88,
    height: 88,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  previewInfo: {
    flex: 1,
    gap: spacing.xxs,
  },
  label: {
    ...typography.label,
  },
  hex: {
    ...typography.headline,
  },
  sliderGroup: {
    gap: spacing.sm,
  },
  rainbow: {
    height: 8,
    borderRadius: radius.round,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});
