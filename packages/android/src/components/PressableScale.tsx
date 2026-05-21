import React, { useCallback } from 'react';
import {
  GestureResponderEvent,
  Pressable,
  PressableProps,
  StyleProp,
  ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { motion } from '../theme';
import { haptics } from '../lib/haptics';

type HapticType = 'tap' | 'pick' | 'press' | 'success' | 'warn' | 'error' | 'none';

type Props = Omit<PressableProps, 'style' | 'children' | 'onPress'> & {
  onPress?: (event: GestureResponderEvent) => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  hapticType?: HapticType;
  /** If true, suppress the press-in scale entirely. Useful for wrapped list items. */
  flat?: boolean;
  /** Scale value on press-in. */
  pressedScale?: number;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Universal pressable — scales to 0.96 with a snappy spring and fires haptics.
 * Every tappable surface in the app composes this.
 */
export function PressableScale({
  onPress,
  style,
  children,
  hapticType = 'tap',
  flat = false,
  pressedScale = 0.96,
  disabled,
  ...rest
}: Props) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(() => {
    if (disabled || flat) return;
    scale.value = withSpring(pressedScale, motion.spring.snappy);
  }, [disabled, flat, pressedScale, scale]);

  const handlePressOut = useCallback(() => {
    if (flat) return;
    scale.value = withSpring(1, motion.spring.snappy);
  }, [flat, scale]);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      if (disabled) return;
      if (hapticType !== 'none') haptics[hapticType]();
      onPress?.(event);
    },
    [disabled, hapticType, onPress]
  );

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      style={[animatedStyle, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
