import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import { ColorPickerModal } from '../screens/ColorPickerModal';
import { StyleGuideScreen } from '../screens/dev/StyleGuideScreen';
import { ModeRouter } from './ModeRouter';
import { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Phase 2: the root is a single ModeRouter screen + modal-presented dev
 * routes. The pre-redesign bottom tabs (Home / History / Settings) are gone.
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
      <Stack.Screen
        name="ColorPicker"
        component={ColorPickerModal}
        options={{
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
        }}
      />
    </Stack.Navigator>
  );
}
