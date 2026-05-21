import { Code, Moon, Sun } from 'lucide-react-native';
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, typography, useTheme } from '../theme';

const REPO_URL = 'https://github.com/CedrickGD/Convert-X';

/**
 * Top header — GitHub icon (left) · Convert-X wordmark (center) · theme toggle (right).
 *
 * Ports the desktop App.svelte header. Notch-aware via safe-area insets.
 */
export function AppHeader() {
  const { theme, settings, setColorScheme } = useTheme();
  const insets = useSafeAreaInsets();

  const onToggleTheme = () => {
    setColorScheme(theme.isDark ? 'light' : 'dark');
  };

  const onOpenRepo = () => {
    Linking.openURL(REPO_URL).catch(() => {
      // non-fatal — user can copy from credits screen
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.md }]}>
      <Pressable
        onPress={onOpenRepo}
        hitSlop={10}
        accessibilityRole="link"
        accessibilityLabel="View source on GitHub"
        style={({ pressed }) => [
          styles.iconBtn,
          {
            borderColor: theme.border.subtle,
            backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
          },
        ]}
      >
        <Code size={18} strokeWidth={1.8} color={theme.text.secondary} />
      </Pressable>

      <Text style={[styles.wordmark, { color: theme.text.primary }]} numberOfLines={1}>
        Convert-<Text style={{ color: theme.accent.primary }}>X</Text>
      </Text>

      <Pressable
        onPress={onToggleTheme}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={theme.isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        style={({ pressed }) => [
          styles.iconBtn,
          {
            borderColor: theme.border.subtle,
            backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
          },
        ]}
      >
        {theme.isDark ? (
          <Sun size={18} strokeWidth={1.8} color={theme.text.secondary} />
        ) : (
          <Moon size={18} strokeWidth={1.8} color={theme.text.secondary} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.huge,
    paddingBottom: spacing.xxs,
    gap: spacing.md,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    ...typography.display,
    flex: 1,
    textAlign: 'center',
  },
});
