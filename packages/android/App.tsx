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
import { ThemeProvider, useTheme } from './src/theme';

SplashScreen.preventAutoHideAsync().catch(() => {
  // If preventing fails (e.g. already hidden), that's fine — we continue.
});

export default function App() {
  // Inter is the desktop typeface. Loaded here so the splash holds until
  // fonts resolve and we never flash a system font on first paint.
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
          <Root fontsReady={fontsLoaded || !!fontError} />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root({ fontsReady }: { fontsReady: boolean }) {
  const { theme, hydrated } = useTheme();
  const ready = hydrated && fontsReady;

  // Sync the native root bg with the theme so edges match during navigation /
  // orientation changes / keyboard avoidance.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.bg.base).catch(() => {
      // non-fatal
    });
  }, [theme.bg.base]);

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {
        // non-fatal
      });
    }
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
    // Keep the splash up until settings hydrate and fonts load.
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
