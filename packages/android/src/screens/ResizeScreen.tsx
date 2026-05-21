import { Maximize2 } from 'lucide-react-native';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, typography, useTheme } from '../theme';

/**
 * Resize mode — Phase 2 placeholder.
 *
 * Phase 5 fills this in with the desktop ResizeSettings + the existing
 * expo-image-manipulator resize path (plus FFmpeg for video in Phase 5b).
 */
export function ResizeScreen() {
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
          <Maximize2 size={24} strokeWidth={1.8} color={theme.accent.primary} />
        </View>
        <Text style={[styles.title, { color: theme.text.primary }]}>Resize</Text>
        <Text style={[styles.body, { color: theme.text.secondary }]}>
          Image resize ships in Phase 5. Pixels mode, percentage mode, lock aspect ratio —
          mirroring the desktop ResizeSettings panel.
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
