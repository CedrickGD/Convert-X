import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import { HistoryScreen } from '../screens/HistoryScreen';
import { PlatformLoginScreen } from '../screens/PlatformLoginScreen';
import { ModeRouter } from './ModeRouter';
import { RootStackParamList } from './types';

// Dev-only: require()'d under __DEV__ so Metro dead-code-eliminates the
// ~770-line styleguide screen (and its imports) from release bundles. A bare
// `import` would ship it and leave navigate('StyleGuide') reachable in prod.
const StyleGuideScreen = __DEV__
  ? (require('../screens/dev/StyleGuideScreen') as typeof import('../screens/dev/StyleGuideScreen'))
      .StyleGuideScreen
  : undefined;

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Phase 2+: the root is a single ModeRouter screen + a dev-only StyleGuide
 * modal. The pre-redesign bottom tabs and accent-customization modal are
 * gone (deleted in Phase 3).
 */
export function RootNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Root" component={ModeRouter} />
      {__DEV__ && StyleGuideScreen ? (
        <Stack.Screen
          name="StyleGuide"
          component={StyleGuideScreen}
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
            gestureEnabled: true,
          }}
        />
      ) : null}
      <Stack.Screen
        name="PlatformLogin"
        component={PlatformLoginScreen}
        options={{
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
        }}
      />
      <Stack.Screen
        name="History"
        component={HistoryScreen}
        options={{
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
        }}
      />
    </Stack.Navigator>
  );
}
