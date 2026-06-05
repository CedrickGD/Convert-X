import { FlipHorizontal, FlipVertical, RotateCw, Volume2, VolumeX } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ConvertSettings } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  settings: ConvertSettings;
  onUpdate: (patch: Partial<ConvertSettings>) => void;
  /** True when target format has no audio track (e.g. GIF). Forces the
   *  Sound toggle to a non-interactive "Muted (GIF)" state. */
  audioForcedOff?: boolean;
};

const SPEED_PRESETS = [0.5, 1, 1.5, 2];
const VOLUME_PRESETS = [0, 50, 100, 150, 200];

/**
 * v0.4 video editor controls — strip audio + speed + volume + rotate +
 * flip. Visible inside ConvertScreen when the source is a video.
 *
 * The full ClipEditor (timeline trim + crop overlay + media preview) lands
 * in v0.5 — see `.claude/clip-editor-plan.md`.
 */
export function VideoEditControls({ settings, onUpdate, audioForcedOff = false }: Props) {
  const { theme } = useTheme();
  const audioStripped = settings.stripAudio || audioForcedOff;

  const rotateNext = () => {
    const next: 0 | 90 | 180 | 270 =
      settings.rotate === 0 ? 90 :
      settings.rotate === 90 ? 180 :
      settings.rotate === 180 ? 270 : 0;
    onUpdate({ rotate: next });
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>VIDEO EDIT</Text>

      {/* Audio toggle */}
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.fieldTitle, { color: theme.text.primary }]}>Sound</Text>
          <Text style={[styles.fieldSub, { color: theme.text.muted }]}>
            {audioForcedOff
              ? 'GIF has no audio'
              : settings.stripAudio
              ? 'Removed from output'
              : 'Kept in output'}
          </Text>
        </View>
        <Pressable
          onPress={
            audioForcedOff
              ? undefined
              : () => onUpdate({ stripAudio: !settings.stripAudio })
          }
          disabled={audioForcedOff}
          style={({ pressed }) => [
            styles.audioBtn,
            {
              backgroundColor: audioStripped
                ? theme.status.errorDim
                : theme.accent.subtle,
              borderColor: audioStripped ? theme.status.error : theme.accent.dim,
              opacity: audioForcedOff ? 0.6 : pressed ? 0.7 : 1,
            },
          ]}
        >
          {audioStripped ? (
            <VolumeX size={18} strokeWidth={2} color={theme.status.error} />
          ) : (
            <Volume2 size={18} strokeWidth={2} color={theme.accent.primary} />
          )}
          <Text
            style={[
              styles.audioBtnText,
              { color: audioStripped ? theme.status.error : theme.accent.primary },
            ]}
          >
            {audioStripped ? 'Muted' : 'On'}
          </Text>
        </Pressable>
      </View>

      <View style={[styles.divider, { backgroundColor: theme.border.subtle }]} />

      {/* Speed */}
      <View style={styles.section}>
        <Text style={[styles.subLabel, { color: theme.text.muted }]}>
          SPEED · {settings.speed}×
        </Text>
        <View style={styles.chipRow}>
          {SPEED_PRESETS.map((v) => (
            <Chip
              key={v}
              label={`${v}×`}
              selected={settings.speed === v}
              onPress={() => onUpdate({ speed: v })}
            />
          ))}
        </View>
      </View>

      {/* Volume (only meaningful if audio kept) */}
      {!audioStripped ? (
        <View style={styles.section}>
          <Text style={[styles.subLabel, { color: theme.text.muted }]}>
            VOLUME · {settings.volume}%
          </Text>
          <View style={styles.chipRow}>
            {VOLUME_PRESETS.map((v) => (
              <Chip
                key={v}
                label={`${v}%`}
                selected={settings.volume === v}
                onPress={() => onUpdate({ volume: v })}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={[styles.divider, { backgroundColor: theme.border.subtle }]} />

      {/* Transform — rotate + flip */}
      <View style={styles.section}>
        <Text style={[styles.subLabel, { color: theme.text.muted }]}>TRANSFORM</Text>
        <View style={styles.transformRow}>
          <TransformBtn
            label={`${settings.rotate}°`}
            icon={<RotateCw size={16} strokeWidth={2} color={theme.text.secondary} />}
            active={settings.rotate !== 0}
            onPress={rotateNext}
          />
          <TransformBtn
            label="Flip H"
            icon={<FlipHorizontal size={16} strokeWidth={2} color={theme.text.secondary} />}
            active={settings.flipH}
            onPress={() => onUpdate({ flipH: !settings.flipH })}
          />
          <TransformBtn
            label="Flip V"
            icon={<FlipVertical size={16} strokeWidth={2} color={theme.text.secondary} />}
            active={settings.flipV}
            onPress={() => onUpdate({ flipV: !settings.flipV })}
          />
        </View>
      </View>
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

function TransformBtn({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.transformBtn,
        {
          backgroundColor: active ? theme.accent.subtle : theme.bg.secondary,
          borderColor: active ? theme.accent.dim : theme.border.subtle,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {icon}
      <Text
        style={[
          styles.transformText,
          { color: active ? theme.accent.primary : theme.text.secondary },
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
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  fieldTitle: { ...typography.bodyEmph },
  fieldSub: { ...typography.caption, marginTop: 2 },
  audioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  audioBtnText: { ...typography.caption, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth },
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
  transformRow: { flexDirection: 'row', gap: spacing.sm },
  transformBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  transformText: { ...typography.caption, fontWeight: '600' },
});
