import { Download as DownloadIcon } from 'lucide-react-native';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, typography, useTheme } from '../theme';

/**
 * Download mode — Phase 2 placeholder.
 *
 * Phase 6 ships the actual yt-dlp wrapper as a custom Expo Module (Kotlin)
 * with YouTube / Spotify / Twitter / Instagram support and multi-asset
 * carousel selection.
 */
export function DownloadScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scroll,
        { paddingBottom: insets.bottom + spacing.giant },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
      >
        <View style={[styles.iconWrap, { backgroundColor: theme.accent.subtle }]}>
          <DownloadIcon size={24} strokeWidth={1.8} color={theme.accent.primary} />
        </View>
        <Text style={[styles.title, { color: theme.text.primary }]}>Downloader</Text>
        <Text style={[styles.body, { color: theme.text.secondary }]}>
          YouTube, Spotify, Twitter/X, Instagram and more. Lands in Phase 6 once the
          yt-dlp native module is wired up.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.md,
    flexGrow: 1,
    justifyContent: 'center',
  },
  card: {
    padding: spacing.giant,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    gap: spacing.xl,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...typography.title },
  body: { ...typography.body, textAlign: 'center' },
});
