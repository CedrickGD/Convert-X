import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { spacing, typography, useTheme } from '../theme';

type Props = {
  children: string;
  trailing?: React.ReactNode;
};

/**
 * Small uppercase section header with optional trailing slot.
 */
export function SectionLabel({ children, trailing }: Props) {
  const { theme } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.text, { color: theme.text.tertiary }]}>{children}</Text>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  text: {
    ...typography.label,
  },
  trailing: {
    marginLeft: spacing.sm,
  },
});
