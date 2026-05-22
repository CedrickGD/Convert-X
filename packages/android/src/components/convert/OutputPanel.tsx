import { Check, RotateCcw, Save, Share2 } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import * as Sharing from 'expo-sharing';

import { prettyBytes } from '../../lib/formats';
import { saveToGallery } from '../../lib/image';
import type { FileEntry } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  files: FileEntry[];
  /** "converted" or "resized" — controls the title copy. */
  actionLabel?: string;
  onStartOver: () => void;
};

/**
 * Port of desktop OutputPanel.svelte.
 *
 * Centered emerald check ring (scale-in animation), title, error count
 * (if any), per-file results with share + save-to-gallery actions, and
 * a "Convert more" primary button.
 */
export function OutputPanel({ files, actionLabel = 'converted', onStartOver }: Props) {
  const { theme } = useTheme();
  const ringScale = useSharedValue(0);
  const ringOpacity = useSharedValue(0);

  useEffect(() => {
    ringScale.value = withTiming(1, {
      duration: 500,
      easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    });
    ringOpacity.value = withTiming(1, { duration: 300 });
  }, [ringOpacity, ringScale]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
    opacity: ringOpacity.value,
  }));

  const done = files.filter((f) => f.status === 'done');
  const errors = files.filter((f) => f.status === 'error');
  const total = done.reduce((sum, f) => sum + (f.outputBytes ?? 0), 0);

  const handleShare = async (uri: string) => {
    const ok = await Sharing.isAvailableAsync();
    if (!ok) {
      Alert.alert('Share unavailable', 'Sharing is not supported on this device.');
      return;
    }
    await Sharing.shareAsync(uri).catch(() => {});
  };

  const handleSave = async (uri: string) => {
    const ok = await saveToGallery(uri);
    Alert.alert(
      ok ? 'Saved' : 'Save failed',
      ok ? 'Image saved to Convert-X album.' : 'Permission denied.'
    );
  };

  return (
    <View style={styles.wrap}>
      <Animated.View
        style={[
          styles.ring,
          { backgroundColor: theme.accent.subtle },
          ringStyle,
        ]}
      >
        <Check size={28} strokeWidth={2.4} color={theme.accent.primary} />
      </Animated.View>

      <Text style={[styles.title, { color: theme.text.primary }]}>
        {done.length} file{done.length !== 1 ? 's' : ''} {actionLabel}
      </Text>

      {errors.length > 0 ? (
        <>
          <Text style={[styles.errors, { color: theme.status.error }]}>
            {errors.length} file{errors.length !== 1 ? 's' : ''} failed
          </Text>
          {errors[0]?.error ? (
            <Text
              style={[styles.errorDetail, { color: theme.text.muted }]}
              numberOfLines={3}
            >
              {errors[0].error}
            </Text>
          ) : null}
        </>
      ) : null}

      {done.length > 0 ? (
        <Text style={[styles.totalSize, { color: theme.text.muted }]}>
          {prettyBytes(total)} total
        </Text>
      ) : null}

      <ScrollView
        style={[
          styles.list,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {done.map((f, i) => (
          <View
            key={f.id}
            style={[
              styles.row,
              i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border.subtle } : null,
            ]}
          >
            <View style={styles.rowBody}>
              <Text
                numberOfLines={1}
                style={[styles.rowName, { color: theme.text.primary }]}
              >
                {f.outputName ?? f.name}
              </Text>
              <Text style={[styles.rowMeta, { color: theme.text.muted }]}>
                {prettyBytes(f.outputBytes ?? 0)}
              </Text>
            </View>
            <View style={styles.rowActions}>
              <Pressable
                hitSlop={6}
                onPress={() => f.outputUri && handleSave(f.outputUri)}
                style={({ pressed }) => [
                  styles.iconBtn,
                  {
                    borderColor: theme.border.subtle,
                    backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                  },
                ]}
              >
                <Save size={14} strokeWidth={2} color={theme.text.secondary} />
              </Pressable>
              <Pressable
                hitSlop={6}
                onPress={() => f.outputUri && handleShare(f.outputUri)}
                style={({ pressed }) => [
                  styles.iconBtn,
                  {
                    borderColor: theme.border.subtle,
                    backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                  },
                ]}
              >
                <Share2 size={14} strokeWidth={2} color={theme.text.secondary} />
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>

      <Pressable
        onPress={onStartOver}
        style={({ pressed }) => [
          styles.startOver,
          {
            backgroundColor: theme.accent.primary,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <RotateCcw size={14} strokeWidth={2.2} color={theme.accent.onPrimary} />
        <Text style={[styles.startOverText, { color: theme.accent.onPrimary }]}>
          Convert more
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: spacing.lg,
  },
  ring: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.giant,
  },
  title: { ...typography.titleAlt },
  errors: { ...typography.body },
  errorDetail: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  totalSize: { ...typography.caption },
  list: {
    alignSelf: 'stretch',
    marginTop: spacing.md,
    maxHeight: 240,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  listContent: { paddingVertical: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: { ...typography.base },
  rowMeta: { ...typography.micro },
  rowActions: { flexDirection: 'row', gap: spacing.sm },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startOver: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    paddingHorizontal: spacing.hugeAlt,
    borderRadius: radius.sm,
    marginTop: spacing.md,
  },
  startOverText: { ...typography.body, fontWeight: '600' },
});
