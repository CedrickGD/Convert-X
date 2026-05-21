import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect } from 'react';
import { LayoutChangeEvent, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { motion, radius, spacing, typography, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

export type Segment<T extends string> = {
  key: T;
  label: string;
  icon?: React.ReactNode;
};

type Props<T extends string> = {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Pill-style segmented control. Selected item has the gradient bg;
 * unselected items are plain. Indicator slides with withSpring.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  style,
}: Props<T>) {
  const { theme } = useTheme();
  const [trackWidth, setTrackWidth] = React.useState(0);
  const selectedIndex = Math.max(
    0,
    segments.findIndex((s) => s.key === value)
  );
  const indicatorX = useSharedValue(0);
  const segmentWidth = trackWidth ? trackWidth / segments.length : 0;

  useEffect(() => {
    indicatorX.value = withSpring(segmentWidth * selectedIndex, motion.spring.snappy);
  }, [selectedIndex, segmentWidth, indicatorX]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      onLayout={handleLayout}
      style={[
        styles.track,
        {
          backgroundColor: theme.bg.surfaceSunken,
          borderColor: theme.border.subtle,
        },
        style,
      ]}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          style={[
            styles.indicator,
            {
              width: segmentWidth,
            },
            indicatorStyle,
          ]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={theme.accent.gradient as unknown as readonly [string, string]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
      {segments.map((segment) => {
        const active = segment.key === value;
        return (
          <PressableScale
            key={segment.key}
            onPress={() => onChange(segment.key)}
            hapticType="pick"
            style={styles.segment}
            pressedScale={0.97}
          >
            <View style={styles.segmentInner}>
              {segment.icon ? <View style={styles.icon}>{segment.icon}</View> : null}
              <Text
                style={[
                  styles.label,
                  {
                    color: active ? theme.text.onAccent : theme.text.secondary,
                  },
                ]}
                numberOfLines={1}
              >
                {segment.label}
              </Text>
            </View>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    position: 'relative',
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xxs,
  },
  indicator: {
    position: 'absolute',
    top: spacing.xxs,
    bottom: spacing.xxs,
    left: spacing.xxs,
    borderRadius: radius.round,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
  },
  segmentInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...typography.bodyEmph,
  },
});
