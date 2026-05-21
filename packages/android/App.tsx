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
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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
  // Inter is the desktop typeface. Splash holds until fonts resolve.
  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': require('./assets/fonts/Inter-Regular.ttf'),
    'Inter-Medium': require('./assets/fonts/Inter-Medium.ttf'),
    'Inter-SemiBold': require('./assets/fonts/Inter-SemiBold.ttf'),
    'Inter-Bold': require('./assets/fonts/Inter-Bold.ttf'),
  });

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SharedProvider>
            <ConvertProvider>
              <ResizeProvider>
                <DownloadProvider>
                  <Root fontsReady={fontsLoaded || !!fontError} />
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
