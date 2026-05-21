import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { Check, Copy, Download, Share2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, Layout } from 'react-native-reanimated';

import { prettyBytes } from '../lib/formats';
import { saveToGallery } from '../lib/image';
import { haptics } from '../lib/haptics';
import { radius, spacing, typography, useTheme } from '../theme';
import { GlassCard } from './GlassCard';
import { PressableScale } from './PressableScale';

type Props = {
  uri: string;
  name: string;
  bytes: number;
};

type ActionState = 'idle' | 'busy' | 'done';

export function OutputRow({ uri, name, bytes }: Props) {
  const { theme } = useTheme();
  const [downloadState, setDownloadState] = useState<ActionState>('idle');
  const [copyState, setCopyState] = useState<ActionState>('idle');

  const handleShare = async () => {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert('Share unavailable', 'Sharing is not supported on this device.');
      haptics.warn();
      return;
    }
    try {
      await Sharing.shareAsync(uri);
    } catch {
      haptics.error();
    }
  };

  const handleSave = async () => {
    setDownloadState('busy');
    const ok = await saveToGallery(uri);
    if (ok) {
      haptics.success();
      setDownloadState('done');
      setTimeout(() => setDownloadState('idle'), 1600);
    } else {
      haptics.warn();
      setDownloadState('idle');
      Alert.alert(
        'Permission needed',
        'Convert-X needs photo library access to save files to your gallery.'
      );
    }
  };

  const handleCopy = async () => {
    await Clipboard.setStringAsync(uri);
    haptics.success();
    setCopyState('done');
    setTimeout(() => setCopyState('idle'), 1600);
  };

  return (
    <Animated.View entering={FadeIn.springify().damping(14)} layout={Layout.springify()}>
      <GlassCard padded={false} style={styles.card}>
        <View style={styles.row}>
          <View style={[styles.thumb, { backgroundColor: theme.bg.surfaceSunken }]}>
            <Image
              source={{ uri }}
              style={styles.thumbImage}
              contentFit="cover"
              transition={160}
            />
          </View>
          <View style={styles.body}>
            <Text
              style={[styles.name, { color: theme.text.primary }]}
              numberOfLines={1}
            >
              {name}
            </Text>
            <Text style={[styles.meta, { color: theme.text.tertiary }]} numberOfLines={1}>
              {prettyBytes(bytes)}
            </Text>
          </View>
          <View style={styles.actions}>
            <ActionButton
              onPress={handleShare}
              icon={<Share2 size={18} strokeWidth={1.8} color={theme.text.primary} />}
              bg={theme.bg.surfaceSunken}
            />
            <ActionButton
              onPress={handleSave}
              icon={
                downloadState === 'done' ? (
                  <Check size={18} strokeWidth={2} color={theme.status.success} />
                ) : (
                  <Download size={18} strokeWidth={1.8} color={theme.text.primary} />
                )
              }
              bg={theme.bg.surfaceSunken}
              busy={downloadState === 'busy'}
            />
            <ActionButton
              onPress={handleCopy}
              icon={
                copyState === 'done' ? (
                  <Check size={18} strokeWidth={2} color={theme.status.success} />
                ) : (
                  <Copy size={18} strokeWidth={1.8} color={theme.text.primary} />
                )
              }
              bg={theme.bg.surfaceSunken}
            />
          </View>
        </View>
      </GlassCard>
    </Animated.View>
  );
}

function ActionButton({
  onPress,
  icon,
  bg,
  busy,
}: {
  onPress: () => void;
  icon: React.ReactNode;
  bg: string;
  busy?: boolean;
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={busy}
      hapticType="tap"
      pressedScale={0.9}
      style={[styles.actionBtn, { backgroundColor: bg, opacity: busy ? 0.5 : 1 }]}
    >
      {icon}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: spacing.xxs,
  },
  name: {
    ...typography.bodyEmph,
  },
  meta: {
    ...typography.caption,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
