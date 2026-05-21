import { LinearGradient } from 'expo-linear-gradient';
import { Lock } from 'lucide-react-native';
import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { FormatDef } from '../lib/formats';
import { radius, spacing, typography, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

type Props = {
  format: FormatDef;
  selected: boolean;
  onPress: (format: FormatDef) => void;
};

const UNSUPPORTED_MSG =
  'Coming soon — MP3, video, and GIF conversions arrive in a future update.';

export function FormatChip({ format, selected, onPress }: Props) {
  const { theme } = useTheme();
  const supported = format.supported;

  const handlePress = () => {
    if (!supported) {
      Alert.alert(format.label, UNSUPPORTED_MSG);
      return;
    }
    onPress(format);
  };

  const content = (
    <View
      style={[
        styles.chip,
        {
          borderColor: selected ? 'transparent' : theme.border.subtle,
          backgroundColor: selected ? 'transparent' : theme.bg.surfaceSunken,
          opacity: supported ? 1 : 0.5,
        },
      ]}
    >
      {!supported ? (
        <Lock size={14} strokeWidth={1.8} color={theme.text.tertiary} />
      ) : null}
      <Text
        style={[
          styles.label,
          {
            color: selected ? theme.text.onAccent : theme.text.secondary,
          },
        ]}
      >
        {format.label}
      </Text>
    </View>
  );

  return (
    <PressableScale
      onPress={handlePress}
      hapticType={supported ? 'pick' : 'warn'}
      style={styles.pressable}
      pressedScale={0.94}
    >
      {selected ? (
        <LinearGradient
          colors={theme.accent.gradient as unknown as readonly [string, string]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradientWrap}
        >
          {content}
        </LinearGradient>
      ) : (
        content
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  pressable: {
    borderRadius: radius.round,
  },
  gradientWrap: {
    borderRadius: radius.round,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    ...typography.bodyEmph,
  },
});
