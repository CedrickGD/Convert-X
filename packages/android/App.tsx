import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  Theme as NavTheme,
} from '@react-navigation/native';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from './src/components/ErrorBoundary';
import { FeedbackProvider } from './src/components/Feedback';
import { runPeriodicYtDlpUpdate } from './src/lib/downloadQueue';
import { installErrorCapture } from './src/lib/errorLog';
import { purgeOldExports } from './src/lib/storage';
import { RootNavigator } from './src/navigation/RootNavigator';
import {
  ConvertProvider,
  DownloadProvider,
  ResizeProvider,
  SharedProvider,
} from './src/state';
import { ThemeProvider, useTheme } from './src/theme';

SplashScreen.preventAutoHideAsync().catch(() => {
  // already hidden — fine, continue
});

// Capture uncaught JS errors + unhandled rejections into the local error
// log (Credits → Error log) — release builds have no adb, this is the
// only field-diagnostic trail. Must run before anything can throw.
installErrorCapture();

export default function App() {
  // Inter is the desktop typeface. Splash held until fonts resolved — but
  // in release we saw useFonts hang silently, leaving the splash up forever.
  // 2-second timeout caps the wait; if Inter doesn't load by then the app
  // renders with the system default and the typography looks slightly off
  // — better than a black screen forever.
  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': require('./assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('./assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('./assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('./assets/fonts/Inter-Bold.ttf'),
  });
  const [fontsTimedOut, setFontsTimedOut] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setFontsTimedOut(true), 2000);
    return () => clearTimeout(id);
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <FeedbackProvider>
            <SharedProvider>
              <ConvertProvider>
                <ResizeProvider>
                  <DownloadProvider>
                    <Root fontsReady={fontsLoaded || !!fontError || fontsTimedOut} />
                  </DownloadProvider>
                </ResizeProvider>
              </ConvertProvider>
            </SharedProvider>
          </FeedbackProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root({ fontsReady }: { fontsReady: boolean }) {
  const { theme, hydrated } = useTheme();
  const ready = hydrated && fontsReady;

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.bg.base).catch(() => {});
  }, [theme.bg.base]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Keep yt-dlp fresh: a silent daily check (one redirect request, no
  // GitHub API) that downloads only when a new release exists. Extractors
  // rot within days of a site change and yt-dlp ships fixes weekly — the
  // old once-a-month check left users on a broken engine for weeks.
  // Fire-and-forget; the native updater installs atomically, so a kill
  // mid-download can't corrupt the engine.
  useEffect(() => {
    if (!ready) return;
    void runPeriodicYtDlpUpdate();
  }, [ready]);

  // Reclaim stale app-private exports/downloads on launch so the working
  // copies don't accumulate unbounded. Fire-and-forget.
  useEffect(() => {
    if (!ready) return;
    void purgeOldExports();
  }, [ready]);

  const navTheme = useMemo<NavTheme>(() => {
    const base = theme.isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: theme.isDark,
      colors: {
        ...base.colors,
        primary: theme.accent.primary,
        background: theme.bg.base,
        card: theme.bg.surface,
        text: theme.text.primary,
        border: theme.border.subtle,
        notification: theme.accent.primary,
      },
    };
  }, [theme]);

  if (!ready) {
    return <View style={[styles.root, { backgroundColor: theme.bg.base }]} />;
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.bg.base }]}>
      <NavigationContainer theme={navTheme}>
        <ErrorBoundary
          label="app"
          colors={{
            bg: theme.bg.base,
            text: theme.text.primary,
            muted: theme.text.muted,
            accent: theme.accent.primary,
            onAccent: theme.accent.onPrimary,
            border: theme.border.subtle,
          }}
        >
          <RootNavigator />
        </ErrorBoundary>
      </NavigationContainer>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
