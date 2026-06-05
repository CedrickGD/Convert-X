import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Tiny wrapper around expo-haptics so pressed buttons always feel alive.
 * Haptics are silently no-op on web / unsupported platforms.
 */

export const haptics = {
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  pick: () => safe(() => Haptics.selectionAsync()),
  press: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warn: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};

function safe(fn: () => Promise<unknown>): void {
  if (Platform.OS === 'web') return;
  fn().catch(() => {
    // swallow
  });
}
