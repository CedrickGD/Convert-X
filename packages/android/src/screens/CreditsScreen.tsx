import { Code, Heart, Package, SwatchBook } from 'lucide-react-native';
// expo-constants would let us read the version live — Phase 7 wires it.
// For Phase 2 we surface the package.json value via a static import.
import pkg from '../../package.json';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RootStackParamList } from '../navigation/types';
import { radius, spacing, typography, useTheme } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const REPO_DESKTOP = 'https://github.com/CedrickGD/Convert-X';
const REPO_ANDROID = 'https://github.com/CedrickGD/Convert-X-Android';
const AUTHOR = 'https://github.com/CedrickGD';

const OSS = [
  { name: 'FFmpeg', role: 'media engine (Phase 4)', url: 'https://ffmpeg.org' },
  { name: 'yt-dlp', role: 'downloader (Phase 6)', url: 'https://github.com/yt-dlp/yt-dlp' },
  { name: 'Expo', role: 'native module framework', url: 'https://expo.dev' },
  { name: 'React Native', role: 'UI runtime', url: 'https://reactnative.dev' },
  { name: 'lucide-react-native', role: 'iconography', url: 'https://lucide.dev' },
  { name: 'Inter', role: 'typeface (SIL OFL 1.1)', url: 'https://rsms.me/inter/' },
];

/**
 * Credits & App — Phase 2 placeholder, Phase 7 fills in the rest
 * (latest desktop release fetch, version pinning, inverted CTA framing).
 */
export function CreditsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const version = pkg.version;

  const open = (url: string) => Linking.openURL(url).catch(() => {});

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scroll,
        { paddingBottom: insets.bottom + spacing.giant },
      ]}
      showsVerticalScrollIndicator={false}
    >
      {/* Built by */}
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
      >
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>BUILT BY</Text>
        <Pressable onPress={() => open(AUTHOR)} style={styles.row}>
          <View style={[styles.iconBox, { backgroundColor: theme.accent.subtle }]}>
            <Heart size={18} strokeWidth={1.8} color={theme.accent.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: theme.text.primary }]}>CedrickGD</Text>
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>github.com/CedrickGD</Text>
          </View>
        </Pressable>
      </View>

      {/* Version */}
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
      >
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>VERSION</Text>
        <View style={styles.row}>
          <View style={[styles.iconBox, { backgroundColor: theme.accent.subtle }]}>
            <Package size={18} strokeWidth={1.8} color={theme.accent.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: theme.text.primary }]}>Convert-X Android v{version}</Text>
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>Also available on desktop</Text>
          </View>
        </View>
      </View>

      {/* Source */}
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
      >
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>SOURCE</Text>
        <Pressable onPress={() => open(REPO_ANDROID)} style={styles.row}>
          <View style={[styles.iconBox, { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle, borderWidth: StyleSheet.hairlineWidth }]}>
            <Code size={18} strokeWidth={1.8} color={theme.text.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: theme.text.primary }]}>Convert-X-Android</Text>
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>This app's repository</Text>
          </View>
        </Pressable>
        <View style={[styles.divider, { backgroundColor: theme.border.subtle }]} />
        <Pressable onPress={() => open(REPO_DESKTOP)} style={styles.row}>
          <View style={[styles.iconBox, { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle, borderWidth: StyleSheet.hairlineWidth }]}>
            <Code size={18} strokeWidth={1.8} color={theme.text.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: theme.text.primary }]}>Convert-X (desktop)</Text>
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>Tauri + Svelte + Rust</Text>
          </View>
        </Pressable>
      </View>

      {/* Open source */}
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
      >
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>OPEN SOURCE</Text>
        {OSS.map((it, i) => (
          <React.Fragment key={it.name}>
            {i > 0 ? <View style={[styles.divider, { backgroundColor: theme.border.subtle }]} /> : null}
            <Pressable onPress={() => open(it.url)} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: theme.text.primary }]}>{it.name}</Text>
                <Text style={[styles.rowSub, { color: theme.text.secondary }]}>{it.role}</Text>
              </View>
            </Pressable>
          </React.Fragment>
        ))}
      </View>

      {__DEV__ ? (
        <Pressable
          onPress={() => navigation.navigate('StyleGuide')}
          style={({ pressed }) => [
            styles.card,
            {
              backgroundColor: theme.bg.surface,
              borderColor: theme.border.subtle,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text style={[styles.cardLabel, { color: theme.text.muted }]}>DEVELOPER</Text>
          <View style={styles.row}>
            <View style={[styles.iconBox, { backgroundColor: theme.accent.subtle }]}>
              <SwatchBook size={18} strokeWidth={1.8} color={theme.accent.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: theme.text.primary }]}>Open style guide</Text>
              <Text style={[styles.rowSub, { color: theme.text.secondary }]}>
                Visual reference for the design tokens.
              </Text>
            </View>
          </View>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.md,
    gap: spacing.xl,
  },
  card: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  cardLabel: { ...typography.micro, letterSpacing: 0.6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { ...typography.bodyEmph },
  rowSub: { ...typography.caption, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth },
});
