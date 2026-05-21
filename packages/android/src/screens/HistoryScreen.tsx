import { Clock, Trash2 } from 'lucide-react-native';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '../components/EmptyState';
import { Header } from '../components/Header';
import { OutputRow } from '../components/OutputRow';
import { PressableScale } from '../components/PressableScale';
import { clearHistory, HistoryItem, loadHistory } from '../lib/history';
import { radius, spacing, useTheme } from '../theme';

export function HistoryScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    const data = await loadHistory();
    setItems(data);
  }, []);

  useEffect(() => {
    reload();
    // lightweight polling when screen is mounted — history is small and changes rarely.
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [reload]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const handleClear = useCallback(() => {
    if (items.length === 0) return;
    Alert.alert(
      'Clear history?',
      'This removes all entries from the list. Your exported files remain on disk.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearHistory();
            setItems([]);
          },
        },
      ]
    );
  }, [items.length]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg.base }]}>
      <Header
        title="History"
        subtitle={
          items.length > 0
            ? `${items.length} file${items.length === 1 ? '' : 's'} converted`
            : 'Your conversions'
        }
        trailing={
          items.length > 0 ? (
            <PressableScale
              onPress={handleClear}
              hapticType="warn"
              pressedScale={0.9}
              style={[
                styles.headerBtn,
                {
                  backgroundColor: theme.bg.surfaceSunken,
                  borderColor: theme.border.subtle,
                },
              ]}
            >
              <Trash2 size={18} strokeWidth={1.8} color={theme.text.secondary} />
            </PressableScale>
          ) : null
        }
      />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          items.length === 0 ? styles.centered : undefined,
          { paddingBottom: insets.bottom + spacing.huge + spacing.xl },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.accent.primary}
            colors={[theme.accent.primary]}
          />
        }
      >
        {items.length === 0 ? (
          <EmptyState
            icon={<Clock size={28} strokeWidth={1.8} color={theme.accent.primary} />}
            title="No conversions yet"
            caption="Your converted files will appear here."
          />
        ) : (
          items.map((item) => (
            <View key={item.id} style={styles.rowWrap}>
              <OutputRow uri={item.outputUri} name={item.outputName} bytes={item.bytes} />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.md,
    flexGrow: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowWrap: {
    marginBottom: 0,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
