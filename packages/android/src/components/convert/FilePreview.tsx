import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { prettyBytes } from '../../lib/formats';
import type { FileEntry } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  file: FileEntry;
};

/**
 * Single-file preview card — port of desktop FilePreview.svelte.
 *
 * 16:9 image thumbnail + metadata badges (resolution, size, type).
 */
export function FilePreview({ file }: Props) {
  const { theme } = useTheme();

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      {file.mediaType === 'image' && file.uri ? (
        <View style={[styles.imageWrap, { backgroundColor: '#000' }]}>
          <Image
            source={{ uri: file.uri }}
            style={styles.image}
            contentFit="contain"
            transition={150}
          />
        </View>
      ) : null}

      <View style={styles.meta}>
        <Text
          numberOfLines={1}
          style={[styles.name, { color: theme.text.primary }]}
        >
          {file.name}
        </Text>
        <View style={styles.badges}>
          <Badge label={file.mediaType.toUpperCase()} accent />
          {file.width && file.height ? (
            <Badge label={`${file.width}×${file.height}`} />
          ) : null}
          <Badge label={prettyBytes(file.bytes)} />
        </View>
      </View>
    </View>
  );
}

function Badge({ label, accent }: { label: string; accent?: boolean }) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: accent ? theme.accent.subtle : theme.bg.secondary,
          borderColor: accent ? theme.accent.primary : theme.border.subtle,
        },
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          { color: accent ? theme.accent.primary : theme.text.muted },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  imageWrap: {
    aspectRatio: 16 / 9,
    width: '100%',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  meta: {
    padding: spacing.xl,
    gap: spacing.sm,
  },
  name: { ...typography.body, fontWeight: '600' },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeText: { ...typography.micro },
});
