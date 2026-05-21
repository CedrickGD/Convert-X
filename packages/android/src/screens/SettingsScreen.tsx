import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import {
  Check,
  ExternalLink,
  Info,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sun,
} from 'lucide-react-native';
import React, { useEffect } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { GlassCard } from '../components/GlassCard';
import { Header } from '../components/Header';
import { PressableScale } from '../components/PressableScale';
import { SectionLabel } from '../components/SectionLabel';
import { SegmentedControl } from '../components/SegmentedControl';
import { haptics } from '../lib/haptics';
import { RootStackParamList } from '../navigation/types';
import {
  AccentKey,
  buildTheme,
  ColorScheme,
  motion,
  paletteFromKey,
  PRESET_PALETTES,
  radius,
  spacing,
  typography,
  useTheme,
} from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function SettingsScreen() {
  const { theme, settings, setAccent, setColorScheme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();

  const handleReset = () => {
    Alert.alert(
      'Reset preferences?',
      'This restores the default accent, color scheme, and custom color. History is not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await AsyncStorage.removeItem('@convertx/settings.v1');
            setAccent('purple');
            setColorScheme('dark');
            haptics.success();
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg.base }]}>
      <Header title="Settings" subtitle="Make it yours" />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + spacing.huge + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Appearance */}
        <View style={styles.section}>
          <SectionLabel>Appearance</SectionLabel>
          <GlassCard padded={false} style={styles.card}>
            <View style={styles.cardInner}>
              <Text style={[styles.rowTitle, { color: theme.text.primary }]}>
                Color scheme
              </Text>
              <Text style={[styles.rowCaption, { color: theme.text.tertiary }]}>
                Choose how Convert-X renders.
              </Text>
              <View style={styles.segmentedWrap}>
                <SegmentedControl<ColorScheme>
                  value={settings.colorScheme}
                  onChange={setColorScheme}
                  segments={[
                    {
                      key: 'system',
                      label: 'System',
                      icon: (
                        <Monitor
                          size={16}
                          strokeWidth={1.8}
                          color={
                            settings.colorScheme === 'system'
                              ? theme.text.onAccent
                              : theme.text.secondary
                          }
                        />
                      ),
                    },
                    {
                      key: 'light',
                      label: 'Light',
                      icon: (
                        <Sun
                          size={16}
                          strokeWidth={1.8}
                          color={
                            settings.colorScheme === 'light'
                              ? theme.text.onAccent
                              : theme.text.secondary
                          }
                        />
                      ),
                    },
                    {
                      key: 'dark',
                      label: 'Dark',
                      icon: (
                        <Moon
                          size={16}
                          strokeWidth={1.8}
                          color={
                            settings.colorScheme === 'dark'
                              ? theme.text.onAccent
                              : theme.text.secondary
                          }
                        />
                      ),
                    },
                  ]}
                />
              </View>
            </View>
          </GlassCard>
        </View>

        {/* Accent */}
        <View style={styles.section}>
          <SectionLabel>Accent color</SectionLabel>
          <GlassCard padded={false} style={styles.card}>
            <View style={styles.cardInner}>
              <Text style={[styles.rowTitle, { color: theme.text.primary }]}>
                Palette
              </Text>
              <Text style={[styles.rowCaption, { color: theme.text.tertiary }]}>
                Recolors the entire app.
              </Text>
              <View style={styles.swatches}>
                {PRESET_PALETTES.map((p) => (
                  <Swatch
                    key={p.key}
                    accentKey={p.key}
                    selected={settings.accent === p.key}
                    onPress={() => setAccent(p.key)}
                  />
                ))}
                <Swatch
                  accentKey="custom"
                  selected={settings.accent === 'custom'}
                  onPress={() => navigation.navigate('ColorPicker')}
                />
              </View>
            </View>
          </GlassCard>
        </View>

        {/* About */}
        <View style={styles.section}>
          <SectionLabel>About</SectionLabel>
          <GlassCard padded={false} style={styles.card}>
            <AboutRow
              icon={<Info size={18} strokeWidth={1.8} color={theme.text.primary} />}
              title="Convert-X"
              subtitle="Version 0.1.0"
            />
            <Divider />
            <AboutRow
              icon={<Monitor size={18} strokeWidth={1.8} color={theme.text.primary} />}
              title="Desktop app available"
              subtitle="Built for Samsung Galaxy S21 FE and the rest of us."
            />
            <Divider />
            <AboutRow
              icon={<ExternalLink size={18} strokeWidth={1.8} color={theme.text.primary} />}
              title="Made by CedrickGD"
              subtitle="Crafted with care in React Native."
            />
          </GlassCard>
        </View>

        {/* Reset */}
        <View style={styles.section}>
          <PressableScale
            onPress={handleReset}
            hapticType="warn"
            style={[
              styles.resetBtn,
              { borderColor: theme.border.strong },
            ]}
          >
            <RotateCcw size={18} strokeWidth={1.8} color={theme.text.primary} />
            <Text style={[styles.resetText, { color: theme.text.primary }]}>
              Reset preferences
            </Text>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
  );
}

type SwatchProps = {
  accentKey: AccentKey;
  selected: boolean;
  onPress: () => void;
};

function Swatch({ accentKey, selected, onPress }: SwatchProps) {
  const { theme, settings } = useTheme();
  const progress = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(selected ? 1 : 0, motion.spring.snappy);
  }, [selected, progress]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + progress.value * 0.1 }],
  }));

  // Build the swatch's own palette colors (so it shows its accent even if it's not selected)
  const own = paletteFromKey(
    accentKey,
    accentKey === 'custom' ? settings.customHue : undefined,
    accentKey === 'custom' ? settings.customSaturation : undefined
  );
  const ownTheme = buildTheme(own, theme.isDark);
  const label =
    accentKey === 'custom'
      ? 'Custom'
      : PRESET_PALETTES.find((p) => p.key === accentKey)?.label ?? accentKey;

  return (
    <PressableScale onPress={onPress} hapticType="pick" pressedScale={0.9} style={styles.swatchCol}>
      <View style={styles.swatchRing}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.selectedRing,
            {
              borderColor: theme.accent.primary,
            },
            ringStyle,
          ]}
        />
        <View style={styles.swatchClip}>
          {accentKey === 'custom' ? (
            <LinearGradient
              colors={['#FF3D6E', '#FFB037', '#2ECC71', '#3CB5FF', '#8E48FF'] as unknown as readonly [
                string,
                string,
                ...string[],
              ]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.swatchFill}
            />
          ) : (
            <LinearGradient
              colors={ownTheme.accent.gradient as unknown as readonly [string, string]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.swatchFill}
            />
          )}
          {selected ? (
            <View style={styles.swatchCheck}>
              <Check size={16} strokeWidth={2.2} color="#fff" />
            </View>
          ) : null}
        </View>
      </View>
      <Text style={[styles.swatchLabel, { color: theme.text.tertiary }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

function AboutRow({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  const { theme } = useTheme();
  return (
    <View style={styles.aboutRow}>
      <View
        style={[
          styles.aboutIcon,
          {
            backgroundColor: theme.bg.surfaceSunken,
            borderColor: theme.border.subtle,
          },
        ]}
      >
        {icon}
      </View>
      <View style={styles.aboutBody}>
        <Text style={[styles.rowTitle, { color: theme.text.primary }]}>{title}</Text>
        <Text style={[styles.rowCaption, { color: theme.text.tertiary }]}>{subtitle}</Text>
      </View>
    </View>
  );
}

function Divider() {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.divider,
        { backgroundColor: theme.border.subtle },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.xl,
  },
  section: {
    gap: spacing.sm,
  },
  card: {
    overflow: 'hidden',
  },
  cardInner: {
    padding: spacing.lg,
    gap: spacing.xs,
  },
  rowTitle: {
    ...typography.bodyEmph,
  },
  rowCaption: {
    ...typography.caption,
  },
  segmentedWrap: {
    marginTop: spacing.md,
  },
  swatches: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.md,
    columnGap: spacing.md,
    marginTop: spacing.md,
  },
  swatchCol: {
    alignItems: 'center',
    gap: spacing.xs,
    width: '22%',
  },
  swatchRing: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedRing: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: radius.round,
    borderWidth: 2,
  },
  swatchClip: {
    width: 44,
    height: 44,
    borderRadius: radius.round,
    overflow: 'hidden',
  },
  swatchFill: {
    ...StyleSheet.absoluteFillObject,
  },
  swatchCheck: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchLabel: {
    ...typography.micro,
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  aboutIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  aboutBody: {
    flex: 1,
    gap: spacing.xxs,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.lg,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetText: {
    ...typography.bodyEmph,
  },
});
