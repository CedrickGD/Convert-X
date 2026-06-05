import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Check, Code, Cookie, Download, Heart, Package, RefreshCw, SwatchBook, Trash2 } from 'lucide-react-native';
// Phase 2 used a static import for the version; the in-app updater (Phase 9)
// uses the same source of truth.
import pkg from '../../package.json';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { updateYtDlp } from '../lib/downloadQueue';
import { useDownload } from '../state';
import { checkForUpdate, downloadAndInstall, UpdateInfo } from '../lib/updater';
import { prettyBytes } from '../lib/formats';
import { RootStackParamList } from '../navigation/types';
import { radius, spacing, typography, useTheme } from '../theme';
import { normalizeHex, readableOn } from '../lib/color';
import { ColorPicker } from '../components/ColorPicker';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const REPO_DESKTOP = 'https://github.com/CedrickGD/Convert-X';
const REPO_ANDROID = 'https://github.com/CedrickGD/Convert-X-Android-APK';
const AUTHOR = 'https://github.com/CedrickGD';

const OSS = [
  { name: 'FFmpeg', role: 'media engine', url: 'https://ffmpeg.org' },
  { name: 'yt-dlp', role: 'downloader', url: 'https://github.com/yt-dlp/yt-dlp' },
  { name: 'Expo', role: 'native module framework', url: 'https://expo.dev' },
  { name: 'React Native', role: 'UI runtime', url: 'https://reactnative.dev' },
  { name: 'lucide-react-native', role: 'iconography', url: 'https://lucide.dev' },
  { name: 'Inter', role: 'typeface (SIL OFL 1.1)', url: 'https://rsms.me/inter/' },
];

/** Default accent (dark-mode emerald). Selecting it resets to the stock look. */
const DEFAULT_ACCENT = '#10b981';

/** Curated accent presets shown as tappable swatches. */
const PRESET_ACCENTS: { name: string; hex: string }[] = [
  { name: 'Emerald', hex: DEFAULT_ACCENT },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Lime', hex: '#84cc16' },
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

      {/* Appearance — custom accent color, persisted */}
      <AccentColorCard />

      {/* Updates — sideload self-update from GitHub Releases */}
      <UpdateCard />

      {/* yt-dlp engine refresh — fixes Instagram CSRF errors etc. */}
      <YtDlpUpdateCard />

      {/* Cookies — required for Instagram and other login-walled sites */}
      <CookiesCard />

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

// ── Accent color ────────────────────────────────────────────────────────
// User-pickable highlight color. Persisted via ThemeProvider settings; the
// whole app re-themes live because every component reads theme.accent.*.
// Presets reset to the default emerald via setAccentColor(null); custom = any hex.

function AccentColorCard() {
  const { theme, settings, setAccentColor, previewAccentColor } = useTheme();
  const active = settings.accentColor;
  const isDefault = !active;
  const current = active ?? DEFAULT_ACCENT;

  // The hex field doubles as a live readout: it mirrors the current color
  // (updating as the picker is dragged) unless the user is editing it.
  const [hexInput, setHexInput] = useState(current);
  const [hexFocused, setHexFocused] = useState(false);
  const [hexError, setHexError] = useState(false);
  const livePreview = normalizeHex(hexInput);

  useEffect(() => {
    if (!hexFocused) {
      setHexInput(current);
      setHexError(false);
    }
  }, [current, hexFocused]);

  const applyHex = useCallback(() => {
    const norm = normalizeHex(hexInput);
    if (!norm) {
      setHexError(true);
      return;
    }
    setHexError(false);
    setAccentColor(norm);
  }, [hexInput, setAccentColor]);

  const reset = useCallback(() => {
    setAccentColor(null);
    setHexError(false);
  }, [setAccentColor]);

  // Recently-picked custom colors, minus any that are already preset swatches.
  const recents = (settings.recentAccents ?? []).filter(
    (c) => !PRESET_ACCENTS.some((p) => p.hex.toLowerCase() === c.toLowerCase())
  );

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <View style={styles.cardHeaderRow}>
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>ACCENT COLOR</Text>
        {!isDefault ? (
          <Pressable onPress={reset} hitSlop={8}>
            <Text style={[styles.linkText, { color: theme.accent.primary }]}>Reset</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={[styles.rowSub, { color: theme.text.secondary }]}>
        {isDefault
          ? 'Default emerald — drag the picker, tap a swatch, or enter a hex.'
          : `Custom · ${active}`}
      </Text>

      <ColorPicker
        value={active ?? DEFAULT_ACCENT}
        onPreview={previewAccentColor}
        onCommit={setAccentColor}
      />

      {recents.length > 0 ? (
        <>
          <Text style={[styles.cardLabel, { color: theme.text.muted, marginTop: spacing.xs }]}>
            RECENT
          </Text>
          <View style={styles.swatchGrid}>
            {recents.map((hex) => {
              const selected = active?.toLowerCase() === hex.toLowerCase();
              return (
                <Pressable
                  key={hex}
                  accessibilityRole="button"
                  accessibilityLabel={`Recent color ${hex}`}
                  onPress={() => setAccentColor(hex)}
                  style={({ pressed }) => [
                    styles.swatch,
                    {
                      backgroundColor: hex,
                      borderColor: selected ? theme.text.primary : 'transparent',
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  {selected ? <Check size={16} strokeWidth={3} color={readableOn(hex)} /> : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      <Text style={[styles.cardLabel, { color: theme.text.muted, marginTop: spacing.xs }]}>
        QUICK PICKS
      </Text>
      <View style={styles.swatchGrid}>
        {PRESET_ACCENTS.map((p) => {
          const selected =
            p.hex === DEFAULT_ACCENT ? isDefault || active === p.hex : active === p.hex;
          return (
            <Pressable
              key={p.hex}
              accessibilityRole="button"
              accessibilityLabel={`${p.name} accent`}
              onPress={() => setAccentColor(p.hex === DEFAULT_ACCENT ? null : p.hex)}
              style={({ pressed }) => [
                styles.swatch,
                {
                  backgroundColor: p.hex,
                  borderColor: selected ? theme.text.primary : 'transparent',
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              {selected ? <Check size={16} strokeWidth={3} color={readableOn(p.hex)} /> : null}
            </Pressable>
          );
        })}
      </View>

      <View
        style={[
          styles.hexRow,
          {
            backgroundColor: theme.bg.surfaceSunken,
            borderColor: hexError ? theme.status.error : theme.border.subtle,
          },
        ]}
      >
        <View
          style={[
            styles.hexPreview,
            {
              backgroundColor: livePreview ?? active ?? DEFAULT_ACCENT,
              borderColor: theme.border.subtle,
            },
          ]}
        />
        <TextInput
          value={hexInput}
          onChangeText={(t) => {
            setHexInput(t);
            if (hexError) setHexError(false);
          }}
          onFocus={() => setHexFocused(true)}
          onBlur={() => setHexFocused(false)}
          placeholder="#7c3aed"
          placeholderTextColor={theme.text.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={applyHex}
          style={[styles.hexInput, { color: theme.text.primary }]}
        />
        <Pressable
          onPress={applyHex}
          hitSlop={6}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={[styles.linkText, { color: theme.accent.primary }]}>Apply</Text>
        </Pressable>
      </View>
      {hexError ? (
        <Text style={[styles.rowSub, { color: theme.status.error }]}>
          Enter a valid hex, e.g. #7c3aed.
        </Text>
      ) : null}
    </View>
  );
}

// ── Update card ─────────────────────────────────────────────────────────
// Auto-checks GitHub Releases on mount; lets the user tap to re-check or
// install. State machine keeps the UI debounced.

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; pct: number; info: UpdateInfo }
  | { kind: 'up-to-date' }
  | { kind: 'error' };

function UpdateCard() {
  const { theme } = useTheme();
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });

  // Auto-check once on mount. Silent on failure.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: 'checking' });
      const info = await checkForUpdate();
      if (cancelled) return;
      setState(info ? { kind: 'available', info } : { kind: 'up-to-date' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onCheck = useCallback(async () => {
    if (state.kind === 'downloading' || state.kind === 'checking') return;
    setState({ kind: 'checking' });
    try {
      const info = await checkForUpdate();
      setState(info ? { kind: 'available', info } : { kind: 'up-to-date' });
    } catch {
      setState({ kind: 'error' });
    }
  }, [state.kind]);

  const onInstall = useCallback(async () => {
    if (state.kind !== 'available') return;
    const info = state.info;
    setState({ kind: 'downloading', pct: 0, info });
    try {
      await downloadAndInstall(info, (pct) =>
        setState({ kind: 'downloading', pct, info })
      );
      // After the install sheet appears, Android takes over.
      setState({ kind: 'available', info });
    } catch {
      setState({ kind: 'error' });
    }
  }, [state]);

  const subline =
    state.kind === 'checking' ? 'Checking GitHub…' :
    state.kind === 'up-to-date' ? 'You have the latest version.' :
    state.kind === 'available' ? `v${state.info.version} · ${prettyBytes(state.info.apkSize)}` :
    state.kind === 'downloading' ? `Downloading… ${state.pct}%` :
    state.kind === 'error' ? 'Could not check for updates.' :
    'Tap to check for updates.';

  const cta =
    state.kind === 'available' ? 'Install' :
    state.kind === 'downloading' ? null :
    'Check';

  const busy = state.kind === 'checking' || state.kind === 'downloading';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>UPDATES</Text>
      <View style={styles.row}>
        <View style={[styles.iconBox, { backgroundColor: theme.accent.subtle }]}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.accent.primary} />
          ) : (
            <Download size={18} strokeWidth={1.8} color={theme.accent.primary} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: theme.text.primary }]}>
            {state.kind === 'available' ? 'Update available' : 'App update'}
          </Text>
          <Text style={[styles.rowSub, { color: theme.text.secondary }]}>{subline}</Text>
        </View>
        {cta ? (
          <Pressable
            disabled={busy}
            onPress={state.kind === 'available' ? onInstall : onCheck}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.xl,
              paddingVertical: spacing.md,
              borderRadius: radius.xs,
              backgroundColor:
                state.kind === 'available' ? theme.accent.primary : theme.bg.surfaceSunken,
              borderWidth: state.kind === 'available' ? 0 : StyleSheet.hairlineWidth,
              borderColor: theme.border.subtle,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              style={[
                typography.bodyEmph,
                {
                  color:
                    state.kind === 'available' ? theme.accent.onPrimary : theme.text.secondary,
                  fontWeight: '600',
                },
              ]}
            >
              {cta}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ── yt-dlp engine refresh ───────────────────────────────────────────────
// Pulls the latest yt-dlp from yt-dlp/yt-dlp GitHub releases via the
// youtubedl-android bundle. Fixes Instagram CSRF, TikTok extractor
// breakage, etc. The first-ever launch already auto-triggers this; the
// button is for re-running after a future site breaks.

type YtDlpState =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

function YtDlpUpdateCard() {
  const { theme } = useTheme();
  const [state, setState] = useState<YtDlpState>({ kind: 'idle' });

  const onTap = useCallback(async () => {
    if (state.kind === 'updating') return;
    setState({ kind: 'updating' });
    const result = await updateYtDlp();
    if (result.ok) setState({ kind: 'success' });
    else setState({ kind: 'error', message: result.error ?? 'Update failed' });
  }, [state.kind]);

  const subline =
    state.kind === 'updating' ? 'Fetching latest extractors…' :
    state.kind === 'success' ? 'Updated. Try the failing URL again.' :
    state.kind === 'error' ? state.message :
    'Refresh if a site (Instagram, TikTok…) stopped working.';

  const cta = state.kind === 'updating' ? null : 'Update';
  const busy = state.kind === 'updating';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>YT-DLP ENGINE</Text>
      <View style={styles.row}>
        <View style={[styles.iconBox, { backgroundColor: theme.accent.subtle }]}>
          {busy ? (
            <ActivityIndicator size="small" color={theme.accent.primary} />
          ) : (
            <RefreshCw size={18} strokeWidth={1.8} color={theme.accent.primary} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: theme.text.primary }]}>
            Download engine
          </Text>
          <Text
            style={[
              styles.rowSub,
              {
                color: state.kind === 'error' ? theme.status.error : theme.text.secondary,
              },
            ]}
            numberOfLines={3}
          >
            {subline}
          </Text>
        </View>
        {cta ? (
          <Pressable
            disabled={busy}
            onPress={onTap}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.xl,
              paddingVertical: spacing.md,
              borderRadius: radius.xs,
              backgroundColor:
                state.kind === 'success' ? theme.bg.surfaceSunken : theme.accent.primary,
              borderWidth: state.kind === 'success' ? StyleSheet.hairlineWidth : 0,
              borderColor: theme.border.subtle,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              style={[
                typography.bodyEmph,
                {
                  color:
                    state.kind === 'success' ? theme.text.secondary : theme.accent.onPrimary,
                  fontWeight: '600',
                },
              ]}
            >
              {state.kind === 'success' ? 'Done' : cta}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ── Cookies ─────────────────────────────────────────────────────────────
// Instagram + paywalled YouTube + private Reddit/Twitter require an
// authenticated session. yt-dlp accepts a Netscape-format cookies.txt
// file (exported from the user's desktop browser via "Get cookies.txt"
// or similar extensions). We copy the picked file into app-private
// storage on import so yt-dlp can read it after the picker URI expires.

const COOKIES_FILENAME = 'cookies.txt';

function CookiesCard() {
  const { theme } = useTheme();
  const navigation = useNavigation<Nav>();
  const { state, updateSettings } = useDownload();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasCookies = !!state.settings.cookiesPath;

  const onPick = useCallback(async () => {
    if (picking) return;
    setError(null);
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) {
        setPicking(false);
        return;
      }
      const src = result.assets[0].uri;
      const dest = `${FileSystem.documentDirectory}${COOKIES_FILENAME}`;
      const destPath = dest.replace(/^file:\/\//, '');
      try {
        await FileSystem.deleteAsync(dest, { idempotent: true });
      } catch {
        // ignore — file may not exist
      }
      await FileSystem.copyAsync({ from: src, to: dest });
      updateSettings({ cookiesPath: destPath });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }, [picking, updateSettings]);

  const onClear = useCallback(async () => {
    const path = state.settings.cookiesPath;
    if (!path) return;
    try {
      await FileSystem.deleteAsync(`file://${path}`, { idempotent: true });
    } catch {
      // best-effort
    }
    updateSettings({ cookiesPath: '' });
  }, [state.settings.cookiesPath, updateSettings]);

  const subline = error
    ? error
    : hasCookies
    ? 'Cookies active. Tap Login to refresh, or trash to disable.'
    : 'Required for Instagram. Tap Login to sign in inside the app.';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>COOKIES</Text>
      <View style={styles.row}>
        <View style={[styles.iconBox, { backgroundColor: theme.accent.subtle }]}>
          {picking ? (
            <ActivityIndicator size="small" color={theme.accent.primary} />
          ) : (
            <Cookie size={18} strokeWidth={1.8} color={theme.accent.primary} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: theme.text.primary }]}>
            Instagram login
          </Text>
          <Text
            style={[
              styles.rowSub,
              { color: error ? theme.status.error : theme.text.secondary },
            ]}
            numberOfLines={3}
          >
            {subline}
          </Text>
        </View>
        {hasCookies ? (
          <Pressable
            onPress={onClear}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.md,
              borderRadius: radius.xs,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Trash2 size={18} strokeWidth={1.8} color={theme.text.secondary} />
          </Pressable>
        ) : null}
        <Pressable
          disabled={picking}
          onPress={() => navigation.navigate('InstagramLogin')}
          style={({ pressed }) => ({
            paddingHorizontal: spacing.xl,
            paddingVertical: spacing.md,
            borderRadius: radius.xs,
            backgroundColor: theme.accent.primary,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text
            style={[
              typography.bodyEmph,
              { color: theme.accent.onPrimary, fontWeight: '600' },
            ]}
          >
            Login
          </Text>
        </Pressable>
      </View>
      <Pressable onPress={onPick}>
        <Text style={[styles.rowSub, { color: theme.text.muted, marginTop: spacing.sm }]}>
          Or import a cookies.txt file from disk →
        </Text>
      </Pressable>
    </View>
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
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  linkText: { ...typography.caption, fontWeight: '600' },
  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  swatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hexPreview: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hexInput: { flex: 1, ...typography.bodySm, paddingVertical: 0 },
});
