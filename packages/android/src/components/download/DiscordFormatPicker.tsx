import { Smile, Sticker } from 'lucide-react-native';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  availableTargets,
  CAPS,
  TARGETS,
  type DiscordMedia,
} from '../../lib/discordMedia';
import type { StickerTarget } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

/**
 * "SAVE AS" chip group for Discord/Tenor/Giphy/Klipy sticker-stealer saves.
 *
 * A chip is enabled when the target is possible for AT LEAST ONE of the
 * selected items (intersection-aware union) — items that can't produce it
 * fall back to Original at save time, which the note below spells out.
 * Disabled chips use FormatPicker's dimmed treatment.
 */
export function DiscordFormatPicker({
  media,
  target,
  onSelect,
}: {
  media: DiscordMedia[];
  target: StickerTarget;
  onSelect: (t: StickerTarget) => void;
}) {
  const { theme } = useTheme();

  // Per-target: enabled if any selected item supports it; keep the first
  // disabled reason for the (rare) all-disabled case.
  const info = useMemo(() => {
    const map = new Map<string, { enabled: boolean; reason: string | null }>();
    for (const t of TARGETS) map.set(t.key, { enabled: false, reason: null });
    for (const m of media) {
      for (const av of availableTargets(m, CAPS.android)) {
        const cur = map.get(av.key);
        if (!cur) continue;
        if (av.enabled) cur.enabled = true;
        else if (!cur.reason && av.reason) cur.reason = av.reason;
      }
    }
    return map;
  }, [media]);

  // How many of the selected items will fall back to Original for the
  // currently-chosen target.
  const fallbackCount = useMemo(() => {
    if (target === 'original') return 0;
    let n = 0;
    for (const m of media) {
      const av = availableTargets(m, CAPS.android).find((x) => x.key === target);
      if (!av || !av.enabled) n += 1;
    }
    return n;
  }, [media, target]);

  const hint = TARGETS.find((t) => t.key === target)?.hint ?? null;

  return (
    <>
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>SAVE AS</Text>
      <View style={styles.chipRow}>
        {TARGETS.map((t) => {
          const meta = info.get(t.key) ?? { enabled: false, reason: null };
          const selected = target === t.key;
          const disabled = !meta.enabled;
          const Icon = t.key === 'sticker' ? Sticker : t.key === 'emoji' ? Smile : null;
          const textColor = selected
            ? theme.accent.onPrimary
            : disabled
            ? theme.text.muted
            : theme.text.secondary;
          return (
            <Pressable
              key={t.key}
              onPress={disabled ? undefined : () => onSelect(t.key as StickerTarget)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled }}
              accessibilityLabel={disabled ? `${t.label}, not available` : t.label}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: selected ? theme.accent.primary : theme.bg.secondary,
                  borderColor: selected ? theme.accent.primary : theme.border.subtle,
                  opacity: disabled ? 0.4 : pressed && !selected ? 0.7 : 1,
                },
              ]}
            >
              {Icon ? (
                <Icon size={13} strokeWidth={2} color={textColor} />
              ) : null}
              <Text style={[styles.chipText, { color: textColor }]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? (
        <Text style={[styles.hint, { color: theme.text.muted }]}>{hint}</Text>
      ) : null}
      {fallbackCount > 0 ? (
        <Text style={[styles.note, { color: theme.status.warning }]}>
          {fallbackCount === media.length
            ? 'Not available for these items — they’ll save as the original.'
            : `${fallbackCount} item${fallbackCount > 1 ? 's' : ''} can’t use this — they’ll save as the original.`}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  cardLabel: { ...typography.micro, letterSpacing: 0.6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { ...typography.caption, fontWeight: '600' },
  hint: { ...typography.caption, marginTop: spacing.xs },
  note: { ...typography.caption, lineHeight: 17 },
});
