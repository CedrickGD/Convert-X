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

import { runFirstLaunchYtDlpUpdate } from './src/lib/downloadQueue';
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
          <SharedProvider>
            <ConvertProvider>
              <ResizeProvider>
                <DownloadProvider>
                  <Root fontsReady={fontsLoaded || !!fontError || fontsTimedOut} />
                </DownloadProvider>
              </ResizeProvider>
            </ConvertProvider>
          </SharedProvider>
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

  // Pull the latest yt-dlp on first launch ever — the bundled extractor
  // in youtubedl-android 0.18.1 is too old for modern Instagram (no CSRF
  // token sent, API returns nothing). Fire-and-forget; success is
  // persisted so this runs at most once. Probe-time corruption recovery
  // handles a half-applied update if the user kills the app mid-fetch.
  useEffect(() => {
    if (!ready) return;
    void runFirstLaunchYtDlpUpdate();
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
        <RootNavigator />
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
