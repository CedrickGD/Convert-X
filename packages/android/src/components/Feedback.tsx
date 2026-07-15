import { AlertTriangle, Check, Info, X } from 'lucide-react-native';
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { haptics } from '../lib/haptics';
import { radius, spacing, typography, useTheme } from '../theme';

/**
 * App-styled feedback: a smooth animated toast for transient messages and a
 * themed confirm modal — replacing the default (ugly, un-themed)
 * Alert.alert. Mount <FeedbackProvider> once near the root; call
 * useFeedback().toast(...) / .confirm(...) anywhere below it.
 */

export type ToastVariant = 'success' | 'error' | 'info';

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type FeedbackValue = {
  toast: (message: string, variant?: ToastVariant) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
};

const FeedbackContext = createContext<FeedbackValue | null>(null);

const TOAST_MS = 2800;

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toastState, setToastState] = useState<{ message: string; variant: ToastVariant } | null>(
    null
  );
  const [confirmState, setConfirmState] = useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((message: string, variant: ToastVariant = 'info') => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToastState({ message, variant });
    if (variant === 'success') haptics.success();
    else if (variant === 'error') haptics.error();
    hideTimer.current = setTimeout(() => setToastState(null), TOAST_MS);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    []
  );

  const closeConfirm = useCallback(
    (result: boolean) => {
      confirmState?.resolve(result);
      setConfirmState(null);
    },
    [confirmState]
  );

  const value = useMemo<FeedbackValue>(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {toastState ? (
        <Toast
          message={toastState.message}
          variant={toastState.variant}
          onDismiss={() => setToastState(null)}
        />
      ) : null}
      <ConfirmDialog state={confirmState} onClose={closeConfirm} />
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackValue {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback must be used inside <FeedbackProvider>');
  return ctx;
}

function Toast({
  message,
  variant,
  onDismiss,
}: {
  message: string;
  variant: ToastVariant;
  onDismiss: () => void;
}) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const tint =
    variant === 'success'
      ? theme.status.success
      : variant === 'error'
      ? theme.status.error
      : theme.accent.primary;
  const Icon = variant === 'success' ? Check : variant === 'error' ? AlertTriangle : Info;

  return (
    <Animated.View
      // Soft slide-up + fade on both appear and dismiss (reanimated plays the
      // exit even as the parent unmounts us after the timer).
      entering={FadeInDown.duration(260).easing(Easing.out(Easing.cubic))}
      exiting={FadeOutDown.duration(200).easing(Easing.in(Easing.cubic))}
      pointerEvents="box-none"
      style={[styles.toastWrap, { bottom: insets.bottom + spacing.xl }]}
    >
      <Pressable
        onPress={onDismiss}
        style={[
          styles.toast,
          {
            backgroundColor: theme.bg.surfaceHigh,
            borderColor: theme.border.subtle,
          },
        ]}
      >
        <View style={[styles.toastIcon, { backgroundColor: `${tint}22` }]}>
          <Icon size={15} strokeWidth={2.6} color={tint} />
        </View>
        <Text numberOfLines={2} style={[styles.toastText, { color: theme.text.primary }]}>
          {message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

function ConfirmDialog({
  state,
  onClose,
}: {
  state: (ConfirmOptions & { resolve: (v: boolean) => void }) | null;
  onClose: (result: boolean) => void;
}) {
  const { theme } = useTheme();
  const progress = useSharedValue(0);

  React.useEffect(() => {
    progress.value = withTiming(state ? 1 : 0, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
    });
  }, [state, progress]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.94 + progress.value * 0.06 }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  const confirmTint = state?.destructive ? theme.status.error : theme.accent.primary;

  return (
    <Modal visible={!!state} transparent animationType="none" onRequestClose={() => onClose(false)}>
      <Animated.View style={[styles.scrim, { backgroundColor: theme.overlay.scrim }, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => onClose(false)} />
        <Animated.View
          style={[
            styles.dialog,
            { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
            cardStyle,
          ]}
        >
          <Text style={[styles.dialogTitle, { color: theme.text.primary }]}>{state?.title}</Text>
          {state?.message ? (
            <Text style={[styles.dialogMessage, { color: theme.text.secondary }]}>
              {state.message}
            </Text>
          ) : null}
          <View style={styles.dialogActions}>
            <Pressable
              onPress={() => onClose(false)}
              style={({ pressed }) => [
                styles.dialogBtn,
                {
                  borderColor: theme.border.subtle,
                  borderWidth: StyleSheet.hairlineWidth,
                  backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                },
              ]}
            >
              <Text style={[styles.dialogBtnText, { color: theme.text.secondary }]}>
                {state?.cancelLabel ?? 'Cancel'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onClose(true)}
              style={({ pressed }) => [
                styles.dialogBtn,
                { backgroundColor: confirmTint, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.dialogBtnText, { color: theme.accent.onPrimary }]}>
                {state?.confirmLabel ?? 'OK'}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  toastWrap: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: 460,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    // Soft lift so the toast reads as floating above content.
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  toastIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: { ...typography.bodySm, flexShrink: 1 },
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.huge,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
    gap: spacing.sm,
  },
  dialogTitle: { ...typography.titleAlt },
  dialogMessage: { ...typography.body, lineHeight: 20 },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  dialogBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    minWidth: 96,
    alignItems: 'center',
  },
  dialogBtnText: { ...typography.body, fontWeight: '600' },
});
