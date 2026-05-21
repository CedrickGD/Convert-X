import { LinearGradient } from 'expo-linear-gradient';
import { Plus } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
} from 'react-native-reanimated';

import { motion, radius, spacing, typography, useTheme } from '../theme';
import { GlassCard } from './GlassCard';
import { PressableScale } from './PressableScale';

type Props = {
  onPress: () => void;
  title?: string;
  subtitle?: string;
};

const MOCK_CHIPS = ['JPG', 'PNG', 'WebP'];

/**
 * The hero-sized "pick a file" tile. Radial gradient backdrop, soft pulsing
 * Plus button, and a row of small format-chip mockups for visual richness.
 */
export function FilePickTile({
  onPress,
  title = 'Pick an image',
  subtitle = 'JPG, PNG, or WebP — up to 40 MB',
}: Props) {
  const { theme } = useTheme();
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withSpring(1.08, { ...motion.spring.gentle, mass: 1.2 }),
        withSpring(1, motion.spring.gentle)
      ),
      -1,
      false
    );
    return () => cancelAnimation(pulse);
  }, [pulse]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (pulse.value - 1) * 1.6 }],
    opacity: 1 - (pulse.value - 1) * 4,
  }));

  return (
    <PressableScale onPress={onPress} hapticType="press" pressedScale={0.98}>
      <GlassCard padded={false} glowing style={styles.card}>
        {/* Radial-ish soft gradient backdrop: layered diagonal + top tint */}
        <LinearGradient
          colors={[theme.accent.primarySoft, 'transparent'] as unknown as readonly [string, string]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={['transparent', theme.isDark ? '#00000000' : '#ffffff00']}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.inner}>
          <View style={styles.iconStack}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.halo,
                {
                  backgroundColor: theme.accent.primaryGlow,
                },
                haloStyle,
              ]}
            />
            <Animated.View style={pulseStyle}>
              <LinearGradient
                colors={theme.accent.gradient as unknown as readonly [string, string]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[
                  styles.plusCircle,
                  {
                    shadowColor: theme.accent.primaryGlow,
                  },
                ]}
              >
                <Plus size={28} strokeWidth={1.5} color={theme.text.onAccent} />
              </LinearGradient>
            </Animated.View>
          </View>
          <Text style={[styles.title, { color: theme.text.primary }]}>{title}</Text>
          <Text style={[styles.subtitle, { color: theme.text.tertiary }]}>{subtitle}</Text>
          <View style={styles.chipsRow}>
            {MOCK_CHIPS.map((label) => (
              <View
                key={label}
                style={[
                  styles.chip,
                  {
                    backgroundColor: theme.bg.surfaceSunken,
                    borderColor: theme.border.subtle,
                  },
                ]}
              >
                <Text style={[styles.chipText, { color: theme.text.secondary }]}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </GlassCard>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
  },
  inner: {
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconStack: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  halo: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderRadius: radius.round,
    opacity: 0.2,
  },
  plusCircle: {
    width: 64,
    height: 64,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  title: {
    ...typography.headline,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.caption,
    textAlign: 'center',
  },
  chipsRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    ...typography.micro,
  },
});
