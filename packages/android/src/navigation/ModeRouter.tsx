import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader } from '../components/AppHeader';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Navbar } from '../components/Navbar';
import { ConvertScreen } from '../screens/ConvertScreen';
import { CreditsScreen } from '../screens/CreditsScreen';
import { DownloadScreen } from '../screens/DownloadScreen';
import { ResizeScreen } from '../screens/ResizeScreen';
import { useShared } from '../state';
import { Mode } from '../state/types';
import { spacing, useTheme } from '../theme';

/**
 * The Convert-X root layout — single screen, header + navbar + mode body.
 *
 * We render ALL four mode views and toggle visibility with `display: 'none'`
 * instead of swapping. Two reasons:
 *  - State persists naturally across tab switches (each context's reducer
 *    survives because the mode tree never unmounts).
 *  - ScrollView scroll position is preserved by the OS — switching to
 *    Resize then back to Convert lands you where you left.
 *
 * Per-mode in-flight work is decoupled from this anyway (conversionQueue
 * runs at module scope), so this is belt-and-suspenders against future
 * regressions.
 */
const MODE_RENDERERS: Record<Mode, () => React.ReactElement> = {
  convert: () => <ConvertScreen />,
  resize: () => <ResizeScreen />,
  download: () => <DownloadScreen />,
  credits: () => <CreditsScreen />,
};

const MODE_LABELS: Record<Mode, string> = {
  convert: 'Convert',
  resize: 'Resize',
  download: 'Download',
  credits: 'Credits',
};

export function ModeRouter() {
  const { theme } = useTheme();
  const { activeMode } = useShared();
  const insets = useSafeAreaInsets();

  const boundaryColors = {
    bg: theme.bg.base,
    text: theme.text.primary,
    muted: theme.text.muted,
    accent: theme.accent.primary,
    onAccent: theme.accent.onPrimary,
    border: theme.border.subtle,
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.bg.base }]}>
      <View style={styles.headerWrap}>
        <AppHeader />
        <View style={styles.navWrap}>
          <Navbar />
        </View>
      </View>

      <View style={[styles.body, { paddingBottom: insets.bottom }]}>
        {(Object.keys(MODE_RENDERERS) as Mode[]).map((mode) => (
          <View
            key={mode}
            style={[
              StyleSheet.absoluteFill,
              { display: mode === activeMode ? 'flex' : 'none' },
            ]}
          >
            <ErrorBoundary colors={boundaryColors} label={MODE_LABELS[mode]}>
              {MODE_RENDERERS[mode]()}
            </ErrorBoundary>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerWrap: {
    paddingHorizontal: spacing.huge,
    paddingBottom: spacing.sm,
  },
  navWrap: {
    paddingHorizontal: 0,
  },
  body: {
    flex: 1,
    position: 'relative',
  },
});
