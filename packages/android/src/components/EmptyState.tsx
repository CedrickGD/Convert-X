import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radius, spacing, typography, useTheme } from '../theme';

type Props = {
  icon: React.ReactNode;
  title: string;
  caption?: string;
};

/**
 * A quiet, elegant zero-state. Circle of glass around an icon, then a headline
 * and a one-line caption.
 */
export function EmptyState({ icon, title, caption }: Props) {
  const { theme } = useTheme();

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.iconWrap,
          {
            backgroundColor: theme.bg.surfaceHigh,
            borderColor: theme.border.subtle,
          },
        ]}
      >
        {icon}
      </View>
      <Text style={[styles.title, { color: theme.text.primary }]}>{title}</Text>
      {caption ? (
        <Text style={[styles.caption, { color: theme.text.tertiary }]}>{caption}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.headline,
    textAlign: 'center',
  },
  caption: {
    ...typography.caption,
    textAlign: 'center',
  },
});
