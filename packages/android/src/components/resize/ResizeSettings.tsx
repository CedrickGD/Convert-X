import { Frame, Link2, Unlink2 } from 'lucide-react-native';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { FileEntry, ResizeSettings as ResizeSettingsState } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  files: FileEntry[];
  settings: ResizeSettingsState;
  onUpdate: (patch: Partial<ResizeSettingsState>) => void;
};

const PRESETS = [25, 50, 75, 125, 150, 200];
const OUTPUT_FORMATS = ['same', 'png', 'jpg', 'webp'];

/**
 * Port of desktop ResizeSettings.svelte.
 *
 * Mode toggle (Pixels / Percentage), dimension inputs with lock-aspect,
 * percentage presets, output-dimension preview, format selector.
 *
 * BMP / TIFF formats are stripped from the option list — expo-image-manipulator
 * doesn't support them on mobile (Phase 4 video-engine work will fill those in
 * via FFmpeg if we choose to support them).
 */
export function ResizeSettings({ files, settings, onUpdate }: Props) {
  const { theme } = useTheme();

  const firstImage = files.find((f) => f.mediaType === 'image' && f.width && f.height);
  const origW = firstImage?.width ?? 0;
  const origH = firstImage?.height ?? 0;
  const aspect = origH > 0 ? origW / origH : 1;
  const isBatch = files.filter((f) => f.mediaType === 'image').length > 1;

  const previewDims = useMemo(() => {
    if (origW === 0 || origH === 0) return { w: 0, h: 0 };
    if (settings.mode === 'percentage') {
      const pct = (settings.percent || 100) / 100;
      return {
        w: Math.max(1, Math.round(origW * pct)),
        h: Math.max(1, Math.round(origH * pct)),
      };
    }
    let w = settings.width ?? origW;
    let h = settings.height ?? origH;
    if (settings.keepAspect) {
      if (settings.width && settings.width !== origW) {
        h = Math.max(1, Math.round(w / aspect));
      } else if (settings.height && settings.height !== origH) {
        w = Math.max(1, Math.round(h * aspect));
      }
    }
    return { w, h };
  }, [origW, origH, aspect, settings.mode, settings.percent, settings.width, settings.height, settings.keepAspect]);

  const setWidth = (val: string) => {
    const n = parseInt(val, 10);
    const w = Number.isFinite(n) && n > 0 ? n : null;
    const patch: Partial<ResizeSettingsState> = { width: w };
    if (settings.keepAspect && w && origW > 0) {
      patch.height = Math.max(1, Math.round(w / aspect));
    }
    onUpdate(patch);
  };

  const setHeight = (val: string) => {
    const n = parseInt(val, 10);
    const h = Number.isFinite(n) && n > 0 ? n : null;
    const patch: Partial<ResizeSettingsState> = { height: h };
    if (settings.keepAspect && h && origH > 0) {
      patch.width = Math.max(1, Math.round(h * aspect));
    }
    onUpdate(patch);
  };

  const setPercent = (val: number) => {
    onUpdate({ percent: Math.max(1, val) });
  };

  const toggleAspect = () => {
    const next = !settings.keepAspect;
    const patch: Partial<ResizeSettingsState> = { keepAspect: next };
    if (next && settings.width && origW > 0) {
      patch.height = Math.max(1, Math.round(settings.width / aspect));
    }
    onUpdate(patch);
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.label, { color: theme.text.muted }]}>RESIZE</Text>

      {origW > 0 ? (
        <View style={styles.origRow}>
          <Frame size={12} strokeWidth={2} color={theme.text.muted} />
          <Text style={[styles.origText, { color: theme.text.secondary }]}>
            {origW} × {origH}{' '}
            {isBatch ? (
              <Text style={[styles.varies, { color: theme.text.muted }]}>(first file)</Text>
            ) : null}
          </Text>
        </View>
      ) : null}

      {/* Mode toggle */}
      <View
        style={[
          styles.modeToggle,
          { backgroundColor: theme.bg.secondary, borderColor: theme.border.subtle },
        ]}
      >
        <ModeBtn
          active={settings.mode === 'pixels'}
          onPress={() => onUpdate({ mode: 'pixels' })}
          label="Pixels"
        />
        <ModeBtn
          active={settings.mode === 'percentage'}
          onPress={() => onUpdate({ mode: 'percentage' })}
          label="Percentage"
        />
      </View>

      {settings.mode === 'pixels' ? (
        <View style={styles.dimRow}>
          <View
            style={[
              styles.dimField,
              {
                backgroundColor: theme.bg.surfaceSunken,
                borderColor: theme.border.subtle,
              },
            ]}
          >
            <Text style={[styles.dimLabel, { color: theme.text.muted }]}>W</Text>
            <TextInput
              keyboardType="number-pad"
              value={settings.width != null ? String(settings.width) : ''}
              onChangeText={setWidth}
              placeholder={origW > 0 ? String(origW) : 'Width'}
              placeholderTextColor={theme.text.muted}
              style={[styles.dimInput, { color: theme.text.primary }]}
            />
          </View>
          <Text style={[styles.timesSep, { color: theme.text.muted }]}>×</Text>
          <View
            style={[
              styles.dimField,
              {
                backgroundColor: theme.bg.surfaceSunken,
                borderColor: theme.border.subtle,
              },
            ]}
          >
            <Text style={[styles.dimLabel, { color: theme.text.muted }]}>H</Text>
            <TextInput
              keyboardType="number-pad"
              value={settings.height != null ? String(settings.height) : ''}
              onChangeText={setHeight}
              placeholder={origH > 0 ? String(origH) : 'Height'}
              placeholderTextColor={theme.text.muted}
              style={[styles.dimInput, { color: theme.text.primary }]}
            />
          </View>
          <Pressable
            onPress={toggleAspect}
            style={({ pressed }) => [
              styles.lockBtn,
              {
                backgroundColor: settings.keepAspect ? theme.accent.subtle : theme.bg.secondary,
                borderColor: settings.keepAspect ? theme.accent.dim : theme.border.subtle,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            {settings.keepAspect ? (
              <Link2 size={16} strokeWidth={2} color={theme.accent.primary} />
            ) : (
              <Unlink2 size={16} strokeWidth={2} color={theme.text.muted} />
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.percentSection}>
          <View
            style={[
              styles.percentRow,
              {
                backgroundColor: theme.bg.surfaceSunken,
                borderColor: theme.border.subtle,
              },
            ]}
          >
            <TextInput
              keyboardType="number-pad"
              value={String(settings.percent)}
              onChangeText={(v) => setPercent(parseInt(v, 10) || 1)}
              style={[styles.percentInput, { color: theme.text.primary }]}
            />
            <Text style={[styles.percentSign, { color: theme.accent.primary }]}>%</Text>
          </View>
          <View style={styles.presets}>
            {PRESETS.map((pct) => {
              const active = settings.percent === pct;
              return (
                <Pressable
                  key={pct}
                  onPress={() => setPercent(pct)}
                  style={({ pressed }) => [
                    styles.preset,
                    {
                      backgroundColor: active ? theme.accent.primary : theme.bg.secondary,
                      borderColor: active ? theme.accent.primary : theme.border.subtle,
                      opacity: pressed && !active ? 0.7 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.presetText,
                      { color: active ? theme.accent.onPrimary : theme.text.secondary },
                    ]}
                  >
                    {pct}%
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {previewDims.w > 0 ? (
        <View
          style={[
            styles.outputPreview,
            {
              backgroundColor: theme.accent.subtle,
              borderColor: theme.accent.dim,
            },
          ]}
        >
          <Frame size={12} strokeWidth={2} color={theme.accent.primary} />
          <Text style={[styles.outputText, { color: theme.text.secondary }]}>
            Output:{' '}
            <Text style={[styles.outputDim, { color: theme.text.primary }]}>
              {previewDims.w} × {previewDims.h}
            </Text>
          </Text>
        </View>
      ) : null}

      {/* Output format */}
      <View style={styles.formatSection}>
        <Text style={[styles.subLabel, { color: theme.text.muted }]}>OUTPUT FORMAT</Text>
        <View style={styles.formatGrid}>
          {OUTPUT_FORMATS.map((fmt) => {
            const selected =
              (fmt === 'same' && !settings.outputFormat) || settings.outputFormat === fmt;
            return (
              <Pressable
                key={fmt}
                onPress={() =>
                  onUpdate({ outputFormat: fmt === 'same' ? null : fmt })
                }
                style={({ pressed }) => [
                  styles.fmtBtn,
                  {
                    backgroundColor: selected ? theme.accent.primary : theme.bg.secondary,
                    borderColor: selected ? theme.accent.primary : theme.border.subtle,
                    opacity: pressed && !selected ? 0.7 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.fmtText,
                    { color: selected ? theme.accent.onPrimary : theme.text.secondary },
                  ]}
                >
                  {fmt === 'same' ? 'Same' : fmt.toUpperCase()}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function ModeBtn({
  active,
  onPress,
  label,
}: {
  active: boolean;
  onPress: () => void;
  label: string;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeBtn,
        {
          backgroundColor: active ? theme.bg.surface : 'transparent',
          opacity: pressed && !active ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.modeBtnText,
          { color: active ? theme.text.primary : theme.text.muted },
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
  label: { ...typography.micro, letterSpacing: 0.6 },
  origRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  origText: { ...typography.caption },
  varies: { ...typography.tiny },

  modeToggle: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.xs - 2,
    alignItems: 'center',
  },
  modeBtnText: { ...typography.caption, fontWeight: '600' },

  dimRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dimField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  dimLabel: { ...typography.micro, fontWeight: '600' },
  dimInput: {
    flex: 1,
    ...typography.bodySm,
    paddingVertical: spacing.md,
  },
  timesSep: { ...typography.body },
  lockBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },

  percentSection: { gap: spacing.lg },
  percentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    width: 120,
    gap: spacing.xs,
  },
  percentInput: {
    flex: 1,
    ...typography.body,
    fontWeight: '600',
    paddingVertical: spacing.md,
  },
  percentSign: { ...typography.bodySm, fontWeight: '700' },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico },
  preset: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  presetText: { ...typography.caption, fontWeight: '600' },

  outputPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  outputText: { ...typography.caption },
  outputDim: { ...typography.caption, fontWeight: '700' },

  formatSection: { gap: spacing.sm },
  subLabel: { ...typography.micro, letterSpacing: 0.6 },
  formatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico },
  fmtBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fmtText: { ...typography.caption, fontWeight: '600' },
});
