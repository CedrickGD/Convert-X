import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, Layout } from 'react-native-reanimated';

import { prettyBytes } from '../lib/formats';
import { radius, spacing, typography, useTheme } from '../theme';
import { GlassCard } from './GlassCard';
import { PressableScale } from './PressableScale';

type Props = {
  uri: string;
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  onRemove?: () => void;
};

export function FileRow({ uri, name, bytes, width, height, onRemove }: Props) {
  const { theme } = useTheme();

  const dims =
    width && height ? `${width} × ${height}` : undefined;
  const meta = [dims, prettyBytes(bytes)].filter(Boolean).join('  ·  ');

  return (
    <Animated.View entering={FadeIn.springify().damping(14)} layout={Layout.springify()}>
      <GlassCard padded={false} style={styles.card}>
        <View style={styles.row}>
          <View style={[styles.thumb, { backgroundColor: theme.bg.surfaceSunken }]}>
            <Image
              source={{ uri }}
              style={styles.thumbImage}
              contentFit="cover"
              transition={120}
            />
          </View>
          <View style={styles.body}>
            <Text
              style={[styles.name, { color: theme.text.primary }]}
              numberOfLines={1}
            >
              {name}
            </Text>
            {meta ? (
              <Text style={[styles.meta, { color: theme.text.tertiary }]} numberOfLines={1}>
                {meta}
              </Text>
            ) : null}
          </View>
          {onRemove ? (
            <PressableScale
              onPress={onRemove}
              hapticType="tap"
              style={[styles.remove, { backgroundColor: theme.bg.surfaceSunken }]}
              pressedScale={0.9}
            >
              <X size={16} strokeWidth={1.8} color={theme.text.secondary} />
            </PressableScale>
          ) : null}
        </View>
      </GlassCard>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: spacing.xxs,
  },
  name: {
    ...typography.bodyEmph,
  },
  meta: {
    ...typography.caption,
  },
  remove: {
    width: 32,
    height: 32,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
