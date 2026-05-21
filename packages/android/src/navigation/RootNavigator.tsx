import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import { StyleGuideScreen } from '../screens/dev/StyleGuideScreen';
import { ModeRouter } from './ModeRouter';
import { RootStackParamList } from './types';

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
      <Stack.Screen
        name="StyleGuide"
        component={StyleGuideScreen}
        options={{
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
        }}
      />
    </Stack.Navigator>
  );
}
