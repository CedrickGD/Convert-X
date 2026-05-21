import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing, typography, useTheme } from '../theme';

type Props = {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
};

/**
 * Screen-level header — title, optional subtitle, optional trailing slot.
 * No burger menu. Sits under the notch, respects safe-area insets.
 */
export function Header({ title, subtitle, trailing }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + spacing.sm,
        },
      ]}
    >
      <View style={styles.leading}>
        <Text style={[styles.title, { color: theme.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.text.tertiary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  leading: {
    flex: 1,
    gap: spacing.xxs,
  },
  title: {
    ...typography.title,
  },
  subtitle: {
    ...typography.caption,
  },
  trailing: {
    marginLeft: spacing.md,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
});
