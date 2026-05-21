import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';

import { ColorPickerSheet } from '../components/ColorPickerSheet';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ColorPicker'>;

export function ColorPickerModal({ navigation }: Props) {
  return <ColorPickerSheet onDone={() => navigation.goBack()} />;
}
