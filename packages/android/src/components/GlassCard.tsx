import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  glowing?: boolean;
  intensity?: number;
};

/**
 * Elevated translucent card. Uses BlurView on iOS/Android where it works;
 * on web-ish targets the blur degrades to a tinted surface.
 */
export function GlassCard({ children, style, padded = true, glowing = false, intensity = 30 }: Props) {
  const { theme } = useTheme();

  const tint = theme.isDark ? 'dark' : 'light';

  const glow: ViewStyle | undefined = glowing
    ? {
        shadowColor: theme.accent.primaryGlow,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: theme.isDark ? 0.35 : 0.18,
        shadowRadius: 24,
        elevation: 12,
      }
    : undefined;

  // BlurView on web can be blank; fall back to a solid translucent surface there.
  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.bg.surface,
            borderColor: theme.border.subtle,
          },
          padded && styles.padded,
          glow,
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  return (
    <View style={[styles.outer, glow, style]}>
      <BlurView
        tint={tint}
        intensity={intensity}
        style={[
          styles.card,
          styles.blur,
          {
            backgroundColor: theme.overlay.glass,
            borderColor: theme.border.subtle,
          },
          padded && styles.padded,
        ]}
      >
        {children}
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderRadius: radius.lg,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  blur: {
    // BlurView needs explicit overflow to clip the blur-layer to the radius on Android.
    overflow: 'hidden',
  },
  padded: {
    padding: spacing.lg,
  },
});
