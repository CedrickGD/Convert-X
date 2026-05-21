import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { radius, spacing, typography, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

type Props = {
  children: string;
  onPress?: () => void;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  full?: boolean;
  hapticType?: 'tap' | 'press' | 'success' | 'pick';
};

/**
 * Primary CTA — gradient pill with an optional leading icon and typography.bodyEmph text.
 */
export function GradientButton({
  children,
  onPress,
  leading,
  trailing,
  disabled = false,
  style,
  full = true,
  hapticType = 'press',
}: Props) {
  const { theme } = useTheme();

  const gradientColors = disabled
    ? ([theme.bg.surfaceHigh, theme.bg.surface] as const)
    : theme.accent.gradient;

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      hapticType={disabled ? 'none' : hapticType}
      style={[full && styles.full, disabled && styles.disabled, style]}
    >
      <LinearGradient
        colors={gradientColors as unknown as readonly [string, string]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[
          styles.button,
          {
            shadowColor: theme.accent.primaryGlow,
            shadowOpacity: disabled ? 0 : theme.isDark ? 0.38 : 0.25,
          },
        ]}
      >
        {leading ? <View style={styles.slot}>{leading}</View> : null}
        <Text
          style={[
            styles.text,
            {
              color: disabled ? theme.text.tertiary : theme.text.onAccent,
            },
          ]}
        >
          {children}
        </Text>
        {trailing ? <View style={styles.slot}>{trailing}</View> : null}
      </LinearGradient>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  full: {
    alignSelf: 'stretch',
  },
  disabled: {
    opacity: 0.5,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    gap: spacing.sm,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 16,
    elevation: 6,
  },
  text: {
    ...typography.bodyEmph,
  },
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
