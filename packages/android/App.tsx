import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  Theme as NavTheme,
} from '@react-navigation/native';
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
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Root />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root() {
  const { theme, hydrated } = useTheme();

  // Sync the native root bg with the theme so edges match during navigation /
  // orientation changes / keyboard avoidance.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.bg.base).catch(() => {
      // non-fatal
    });
  }, [theme.bg.base]);

  useEffect(() => {
    if (hydrated) {
      SplashScreen.hideAsync().catch(() => {
        // non-fatal
      });
    }
  }, [hydrated]);

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

  if (!hydrated) {
    // Keep the splash up until settings hydrate — no flash of wrong theme.
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
