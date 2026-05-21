import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Clock, Home, Settings as SettingsIcon } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { LayoutChangeEvent, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  interpolateColor,
  SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { PressableScale } from '../components/PressableScale';
import { motion, radius, spacing, typography, useTheme } from '../theme';
import { TabParamList } from './types';

type IconFor = (props: { color: string; size: number }) => React.ReactNode;

const ICONS: Record<keyof TabParamList, IconFor> = {
  Home: ({ color, size }) => <Home size={size} strokeWidth={1.8} color={color} />,
  History: ({ color, size }) => <Clock size={size} strokeWidth={1.8} color={color} />,
  Settings: ({ color, size }) => (
    <SettingsIcon size={size} strokeWidth={1.8} color={color} />
  ),
};

const LABELS: Record<keyof TabParamList, string> = {
  Home: 'Home',
  History: 'History',
  Settings: 'Settings',
};

/**
 * Custom animated tab bar. Glass bg via BlurView, hairline top border,
 * 4 active affordances: icon color tween, icon scale, pill indicator, haptic pick.
 */
export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [trackWidth, setTrackWidth] = React.useState(0);

  const indicatorX = useSharedValue(0);
  const segmentWidth = trackWidth / state.routes.length;

  useEffect(() => {
    if (segmentWidth <= 0) return;
    indicatorX.value = withSpring(segmentWidth * state.index, motion.spring.snappy);
  }, [state.index, segmentWidth, indicatorX]);

  const indicatorStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: indicatorX.value }],
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      style={[
        styles.container,
        {
          paddingBottom: insets.bottom + spacing.xs,
          borderTopColor: theme.border.subtle,
        },
      ]}
    >
      {Platform.OS !== 'web' ? (
        <BlurView
          intensity={40}
          tint={theme.isDark ? 'dark' : 'light'}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay.glass }]}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg.surface }]} />
      )}

      <View style={styles.inner} onLayout={handleLayout}>
        {segmentWidth > 0 ? (
          <Animated.View pointerEvents="none" style={[styles.indicatorWrap, indicatorStyle]}>
            <View style={styles.indicatorInner}>
              <LinearGradient
                colors={theme.accent.gradient as unknown as readonly [string, string]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[
                  StyleSheet.absoluteFill,
                  { opacity: theme.isDark ? 0.22 : 0.14 },
                ]}
              />
            </View>
          </Animated.View>
        ) : null}

        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const focused = state.index === index;
          const tabKey = route.name as keyof TabParamList;
          const renderIcon = ICONS[tabKey];
          const label = LABELS[tabKey] ?? options.title ?? route.name;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name as never);
            }
          };

          return (
            <TabItem
              key={route.key}
              focused={focused}
              label={label}
              renderIcon={renderIcon}
              onPress={onPress}
              inactiveColor={theme.text.tertiary}
              activeColor={theme.accent.primary}
            />
          );
        })}
      </View>
    </View>
  );
}

type TabItemProps = {
  focused: boolean;
  label: string;
  renderIcon: IconFor;
  onPress: () => void;
  activeColor: string;
  inactiveColor: string;
};

function TabItem({
  focused,
  label,
  renderIcon,
  onPress,
  activeColor,
  inactiveColor,
}: TabItemProps) {
  const progress = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(focused ? 1 : 0, motion.spring.snappy);
  }, [focused, progress]);

  const animatedColor = useDerivedValue(() =>
    interpolateColor(progress.value, [0, 1], [inactiveColor, activeColor])
  );

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.1 }],
  }));

  const labelStyle = useAnimatedStyle(() => ({
    color: animatedColor.value,
    opacity: 0.65 + progress.value * 0.35,
  }));

  // The lucide icons themselves need a static color prop — use the derived value
  // via a bridge component.
  return (
    <PressableScale
      onPress={onPress}
      hapticType="pick"
      style={styles.tab}
      pressedScale={0.95}
    >
      <Animated.View style={[styles.tabInner, iconStyle]}>
        <AnimatedIcon
          progress={progress}
          activeColor={activeColor}
          inactiveColor={inactiveColor}
          renderIcon={renderIcon}
        />
      </Animated.View>
      <Animated.Text style={[styles.tabLabel, labelStyle]} numberOfLines={1}>
        {label}
      </Animated.Text>
    </PressableScale>
  );
}

/**
 * Lucide icons accept a `color` prop and we want to animate it. We can't pass a
 * reanimated SharedValue as a prop, so we render two copies and cross-fade them.
 */
function AnimatedIcon({
  progress,
  activeColor,
  inactiveColor,
  renderIcon,
}: {
  progress: SharedValue<number>;
  activeColor: string;
  inactiveColor: string;
  renderIcon: IconFor;
}) {
  const activeStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  const inactiveStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
  }));

  return (
    <View style={styles.iconStack}>
      <Animated.View style={[StyleSheet.absoluteFill, inactiveStyle]}>
        {renderIcon({ color: inactiveColor, size: 22 })}
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, activeStyle]}>
        {renderIcon({ color: activeColor, size: 22 })}
      </Animated.View>
      {/* Invisible spacer for layout to match icon size */}
      {renderIcon({ color: 'transparent', size: 22 })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  inner: {
    flexDirection: 'row',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    position: 'relative',
  },
  indicatorWrap: {
    position: 'absolute',
    top: spacing.sm,
    bottom: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorInner: {
    width: 56,
    height: '100%',
    borderRadius: radius.round,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.xxs,
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconStack: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    ...typography.micro,
  },
});
