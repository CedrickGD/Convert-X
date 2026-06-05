import { Image as ExpoImage } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { ArrowDownToLine, Clock, Share2, Trash2, X } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { mediaTypeFromName, prettyBytes } from '../lib/formats';
import { haptics } from '../lib/haptics';
import {
  clearHistory,
  getHistory,
  HistoryEntry,
  removeHistoryEntry,
  subscribeHistory,
} from '../lib/history';
import { saveToGallery } from '../lib/image';
import { radius, spacing, typography, useTheme } from '../theme';

const OP_LABEL: Record<HistoryEntry['op'], string> = {
  convert: 'Converted',
  resize: 'Resized',
  download: 'Downloaded',
};

function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function HistoryScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const now = Date.now();

  const refresh = useCallback(() => {
    getHistory().then(setEntries);
  }, []);

  useEffect(() => {
    refresh();
    return subscribeHistory(refresh);
  }, [refresh]);

  const handleShare = useCallback(async (uri: string) => {
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert('Share unavailable', 'Sharing is not supported on this device.');
      return;
    }
    await Sharing.shareAsync(uri).catch(() => {});
  }, []);

  const handleSave = useCallback(async (uri: string) => {
    const res = await saveToGallery(uri);
    if (res.ok) haptics.success();
    else haptics.error();
    Alert.alert(
      res.ok ? 'Saved' : 'Save failed',
      res.ok ? 'Saved to your Convert-X album.' : res.reason ?? 'Could not save to gallery.'
    );
  }, []);

  const handleClear = useCallback(() => {
    Alert.alert('Clear history?', 'This only removes the list — your saved files stay put.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearHistory() },
    ]);
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg.base, paddingTop: insets.top + spacing.md }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Close history"
          style={styles.headerBtn}
        >
          <X size={22} strokeWidth={2} color={theme.text.secondary} />
        </Pressable>
        <Text style={[styles.title, { color: theme.text.primary }]}>History</Text>
        <Pressable
          onPress={handleClear}
          hitSlop={10}
          disabled={entries.length === 0}
          accessibilityRole="button"
          accessibilityLabel="Clear history"
          style={[styles.headerBtn, { opacity: entries.length === 0 ? 0.3 : 1 }]}
        >
          <Text style={[styles.clearText, { color: theme.status.error }]}>Clear</Text>
        </Pressable>
      </View>

      {entries.length === 0 ? (
        <View style={styles.empty}>
          <Clock size={40} strokeWidth={1.5} color={theme.text.muted} />
          <Text style={[styles.emptyText, { color: theme.text.muted }]}>
            Your converted, resized and downloaded files show up here.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.giant }]}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((e) => {
            const cat = mediaTypeFromName(e.name);
            const canSave = cat === 'image' || cat === 'video';
            const isImage = cat === 'image';
            return (
              <View
                key={e.id}
                style={[styles.row, { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle }]}
              >
                {isImage ? (
                  <ExpoImage
                    source={{ uri: e.uri }}
                    style={[styles.thumb, { borderColor: theme.border.subtle }]}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    recyclingKey={e.id}
                  />
                ) : (
                  <View
                    style={[
                      styles.thumb,
                      styles.thumbFallback,
                      { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
                    ]}
                  >
                    <Text style={[styles.thumbExt, { color: theme.text.muted }]}>
                      {(e.name.split('.').pop() ?? '?').toUpperCase()}
                    </Text>
                  </View>
                )}

                <View style={styles.body}>
                  <Text numberOfLines={1} style={[styles.name, { color: theme.text.primary }]}>
                    {e.name}
                  </Text>
                  <Text numberOfLines={1} style={[styles.meta, { color: theme.text.muted }]}>
                    {OP_LABEL[e.op]} · {timeAgo(e.at, now)}
                    {e.bytes > 0 ? ` · ${prettyBytes(e.bytes)}` : ''}
                  </Text>
                </View>

                <View style={styles.actions}>
                  {canSave ? (
                    <IconBtn label={`Save ${e.name} to gallery`} onPress={() => handleSave(e.uri)} theme={theme}>
                      <ArrowDownToLine size={15} strokeWidth={2} color={theme.text.secondary} />
                    </IconBtn>
                  ) : null}
                  <IconBtn label={`Share ${e.name}`} onPress={() => handleShare(e.uri)} theme={theme}>
                    <Share2 size={15} strokeWidth={2} color={theme.text.secondary} />
                  </IconBtn>
                  <IconBtn label={`Remove ${e.name} from history`} onPress={() => void removeHistoryEntry(e.id)} theme={theme}>
                    <Trash2 size={15} strokeWidth={2} color={theme.text.muted} />
                  </IconBtn>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function IconBtn({
  children,
  label,
  onPress,
  theme,
}: {
  children: React.ReactNode;
  label: string;
  onPress: () => void;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.iconBtn,
        { borderColor: theme.border.subtle, backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent' },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.huge,
    paddingBottom: spacing.md,
  },
  headerBtn: { minWidth: 50 },
  title: { ...typography.title },
  clearText: { ...typography.body, fontWeight: '600', textAlign: 'right' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, paddingHorizontal: spacing.giant },
  emptyText: { ...typography.body, textAlign: 'center' },
  list: { paddingHorizontal: spacing.huge, paddingTop: spacing.sm, gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 48, height: 48, borderRadius: radius.xs, borderWidth: StyleSheet.hairlineWidth },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  thumbExt: { ...typography.tiny, fontWeight: '700' },
  body: { flex: 1, gap: 2 },
  name: { ...typography.base },
  meta: { ...typography.micro },
  actions: { flexDirection: 'row', gap: spacing.sm },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
