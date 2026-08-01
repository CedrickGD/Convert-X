import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Check, ChevronDown, ChevronRight, Code, Cookie, Download, Globe, Heart, Monitor, Package, Plus, RefreshCw, SwatchBook, X } from 'lucide-react-native';
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
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as Clipboard from 'expo-clipboard';

import { removePlatformCookies } from '../lib/cookies';
import { updateYtDlp } from '../lib/downloadQueue';
import {
  clearErrorLog,
  ErrorLogEntry,
  getErrorLog,
  subscribeErrorLog,
} from '../lib/errorLog';
import {
  checkInstagramSession,
  invalidateInstagramSessionCache,
} from '../lib/instagramStories';
import { LOGIN_PLATFORMS, LoginPlatform } from '../lib/loginPlatforms';
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
// Cross-platform install destinations (the other two surfaces of Convert-X).
const DESKTOP_RELEASES = 'https://github.com/CedrickGD/Convert-X/releases';
const WEB_URL = 'https://convert-x-online.pages.dev';

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
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>Also on desktop & web</Text>
          </View>
        </View>
      </View>

      {/* Also available on — cross-link to the desktop + web surfaces */}
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
        ]}
      >
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>ALSO AVAILABLE ON</Text>
        <Pressable onPress={() => open(DESKTOP_RELEASES)} style={styles.row}>
          <View style={[styles.iconBox, { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle, borderWidth: StyleSheet.hairlineWidth }]}>
            <Monitor size={18} strokeWidth={1.8} color={theme.text.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: theme.text.primary }]}>Desktop app</Text>
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>Windows installer · MSI</Text>
          </View>
        </Pressable>
        <View style={[styles.divider, { backgroundColor: theme.border.subtle }]} />
        <Pressable onPress={() => open(WEB_URL)} style={styles.row}>
          <View style={[styles.iconBox, { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle, borderWidth: StyleSheet.hairlineWidth }]}>
            <Globe size={18} strokeWidth={1.8} color={theme.text.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: theme.text.primary }]}>Web app</Text>
            <Text style={[styles.rowSub, { color: theme.text.secondary }]}>convert-x-online.pages.dev</Text>
          </View>
        </Pressable>
      </View>

      {/* Appearance — custom accent color, persisted */}
      <AccentColorCard />

      {/* Updates — sideload self-update from GitHub Releases */}
      <UpdateCard />

      {/* yt-dlp engine refresh — fixes Instagram CSRF errors etc. */}
      <YtDlpUpdateCard />

      {/* Cookies — required for Instagram and other login-walled sites */}
      <PlatformLoginsCard />

      {/* Field diagnostics — last probe/download/crash errors, local only */}
      <ErrorLogCard />

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
  const { theme, settings, setAccentColor, previewAccentColor, setQuickPicks, setQuickPicksAuto } =
    useTheme();
  const active = settings.accentColor;
  const isDefault = !active;
  const current = active ?? DEFAULT_ACCENT;

  // Collapsed by default — the picker + swatches only appear on expand.
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

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

  const quickPicks = settings.quickPicks;
  const currentInPicks = quickPicks.some((c) => c.toLowerCase() === current.toLowerCase());

  const removePick = useCallback(
    (hex: string) => setQuickPicks(quickPicks.filter((c) => c.toLowerCase() !== hex.toLowerCase())),
    [quickPicks, setQuickPicks]
  );
  const addCurrentPick = useCallback(
    () => setQuickPicks([current, ...quickPicks]),
    [current, quickPicks, setQuickPicks]
  );

  const summary = isDefault ? 'Default emerald' : `Custom · ${active}`;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      {/* Collapsed header — current color + expand toggle. */}
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse accent color' : 'Expand accent color'}
        style={styles.accentHeader}
      >
        <Text style={[styles.cardLabel, { color: theme.text.muted }]}>ACCENT COLOR</Text>
        <View style={styles.accentHeaderRight}>
          <View style={[styles.accentDot, { backgroundColor: current, borderColor: theme.border.subtle }]} />
          <Text style={[styles.rowSub, { color: theme.text.secondary, marginTop: 0 }]} numberOfLines={1}>
            {summary}
          </Text>
          {expanded ? (
            <ChevronDown size={18} strokeWidth={2} color={theme.text.muted} />
          ) : (
            <ChevronRight size={18} strokeWidth={2} color={theme.text.muted} />
          )}
        </View>
      </Pressable>

      {expanded ? (
        <>
          <ColorPicker
            value={active ?? DEFAULT_ACCENT}
            onPreview={previewAccentColor}
            onCommit={setAccentColor}
          />

          {/* Quick picks — merged recents + presets, editable. */}
          <View style={[styles.cardHeaderRow, { marginTop: spacing.xs }]}>
            <Text style={[styles.cardLabel, { color: theme.text.muted }]}>QUICK PICKS</Text>
            <Pressable onPress={() => setEditing((v) => !v)} hitSlop={8}>
              <Text style={[styles.linkText, { color: theme.accent.primary }]}>
                {editing ? 'Done' : 'Edit'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.swatchGrid}>
            {quickPicks.map((hex) => {
              const selected = current.toLowerCase() === hex.toLowerCase();
              return (
                <View key={hex}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Accent ${hex}`}
                    onPress={() =>
                      editing
                        ? removePick(hex)
                        : setAccentColor(hex.toLowerCase() === DEFAULT_ACCENT ? null : hex)
                    }
                    style={({ pressed }) => [
                      styles.swatch,
                      {
                        backgroundColor: hex,
                        borderColor: selected ? theme.text.primary : 'transparent',
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    {editing ? (
                      <View style={[styles.swatchBadge, { backgroundColor: theme.overlay.scrim }]}>
                        <X size={12} strokeWidth={3} color="#fff" />
                      </View>
                    ) : selected ? (
                      <Check size={16} strokeWidth={3} color={readableOn(hex)} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
            {editing && !currentInPicks ? (
              <Pressable
                accessibilityLabel="Add current color to quick picks"
                onPress={addCurrentPick}
                style={({ pressed }) => [
                  styles.swatch,
                  styles.swatchAdd,
                  { borderColor: theme.border.strong, opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Plus size={18} strokeWidth={2.4} color={theme.text.secondary} />
              </Pressable>
            ) : null}
          </View>

          {/* Auto-add last used toggle. */}
          <View style={styles.cardHeaderRow}>
            <Text style={[styles.rowSub, { color: theme.text.secondary, marginTop: 0 }]}>
              Auto-add last used color
            </Text>
            <Switch
              value={settings.quickPicksAuto}
              onValueChange={setQuickPicksAuto}
              trackColor={{ true: theme.accent.primary, false: theme.bg.surfaceHigh }}
              thumbColor="#fff"
            />
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

          {!isDefault ? (
            <Pressable onPress={reset} hitSlop={8} style={{ alignSelf: 'flex-start' }}>
              <Text style={[styles.linkText, { color: theme.accent.primary }]}>
                Reset to default
              </Text>
            </Pressable>
          ) : null}
        </>
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
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

function YtDlpUpdateCard() {
  const { theme } = useTheme();
  const [state, setState] = useState<YtDlpState>({ kind: 'idle' });

  const onTap = useCallback(async () => {
    if (state.kind === 'updating') return;
    setState({ kind: 'updating' });
    const result = await updateYtDlp();
    if (result.ok) {
      // Tell the user what actually happened — the old card said
      // "Updated." even when the library skipped the download.
      const version = result.version ? ` (${result.version})` : '';
      setState({
        kind: 'success',
        message:
          result.status === 'ALREADY_UP_TO_DATE'
            ? `Already up to date${version}.`
            : `Updated${version}. Try the failing URL again.`,
      });
    } else {
      setState({ kind: 'error', message: result.error ?? 'Update failed' });
    }
  }, [state.kind]);

  const subline =
    state.kind === 'updating' ? 'Fetching latest extractors…' :
    state.kind === 'success' ? state.message :
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

// ── Platform logins ─────────────────────────────────────────────────────
// Private / age-restricted / members-only downloads need an authenticated
// session. Most platforms can be signed into inside an embedded WebView;
// the harvested cookies are merged into a single Netscape cookies.txt that
// yt-dlp reads (see lib/cookies). YouTube is import-only (Google blocks
// embedded-webview sign-in).

const COOKIES_FILENAME = 'cookies.txt';

/**
 * Local error log viewer. Release builds have no adb — this is the only
 * way a field failure (probe, download, crash) can be read back and
 * shared. Collapsed by default; data never leaves the device unless the
 * user copies it.
 */
function ErrorLogCard() {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const refresh = () => void getErrorLog().then(setEntries);
    refresh();
    return subscribeErrorLog(refresh);
  }, []);

  const onCopy = useCallback(async () => {
    const text = entries
      .map(
        (e) =>
          `${new Date(e.at).toISOString()} [${e.scope}] ${e.message}${e.detail ? ` — ${e.detail}` : ''}`
      )
      .join('\n');
    await Clipboard.setStringAsync(text || '(empty)');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [entries]);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardLabel, { color: theme.text.muted }]}>ERROR LOG</Text>
          <Text style={[styles.rowSub, { color: theme.text.secondary }]}>
            {entries.length === 0
              ? 'No recorded errors.'
              : `${entries.length} recorded — stays on this device.`}
          </Text>
        </View>
        {open ? (
          <ChevronDown size={18} strokeWidth={2} color={theme.text.muted} />
        ) : (
          <ChevronRight size={18} strokeWidth={2} color={theme.text.muted} />
        )}
      </Pressable>

      {open ? (
        <>
          {entries.slice(0, 20).map((e, i) => (
            <View
              key={`${e.at}-${i}`}
              style={
                i > 0
                  ? {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: theme.border.subtle,
                      paddingTop: spacing.sm,
                      marginTop: spacing.sm,
                    }
                  : undefined
              }
            >
              <Text style={[styles.rowSub, { color: theme.text.muted }]}>
                {new Date(e.at).toLocaleString()} · {e.scope}
              </Text>
              <Text style={[styles.rowSub, { color: theme.text.primary }]} numberOfLines={4}>
                {e.message}
              </Text>
              {e.detail ? (
                <Text style={[styles.rowSub, { color: theme.text.secondary }]} numberOfLines={2}>
                  {e.detail}
                </Text>
              ) : null}
            </View>
          ))}
          {entries.length > 0 ? (
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Pressable
                onPress={onCopy}
                style={({ pressed }) => ({
                  paddingVertical: spacing.sm,
                  paddingHorizontal: spacing.lg,
                  borderRadius: radius.xs,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.border.subtle,
                  backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                })}
              >
                <Text style={[styles.rowSub, { color: theme.text.primary }]}>
                  {copied ? 'Copied ✓' : 'Copy all'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void clearErrorLog()}
                style={({ pressed }) => ({
                  paddingVertical: spacing.sm,
                  paddingHorizontal: spacing.lg,
                  borderRadius: radius.xs,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.border.subtle,
                  backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                })}
              >
                <Text style={[styles.rowSub, { color: theme.status.error }]}>Clear</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function PlatformLoginsCard() {
  const { theme } = useTheme();
  const navigation = useNavigation<Nav>();
  const { state, updateSettings } = useDownload();
  const [picking, setPicking] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Is the saved Instagram session still accepted by the API? Without
  // this, a lapsed login only surfaces as a failed download later.
  const [igSession, setIgSession] = useState<'ok' | 'expired' | 'unknown'>('unknown');

  const connected = state.settings.connectedPlatforms;
  const igConnected = connected.includes('instagram');

  // Re-check on any cookies change (cookiesPath in deps), not just the
  // connected flag — a re-import keeps the flag true but swaps the session.
  useEffect(() => {
    if (!igConnected) return;
    let active = true;
    void checkInstagramSession().then((s) => {
      if (active) setIgSession(s);
    });
    return () => {
      active = false;
    };
  }, [igConnected, state.settings.cookiesPath]);

  const onImport = useCallback(async () => {
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
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
      await FileSystem.copyAsync({ from: src, to: dest });
      // A manual import REPLACES the whole cookies.txt, so any platform we
      // thought was connected via in-app login may no longer be in the
      // file — clear the flags rather than show a false "Connected".
      invalidateInstagramSessionCache();
      updateSettings({ cookiesPath: destPath, connectedPlatforms: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }, [picking, updateSettings]);

  const onLogout = useCallback(
    async (p: LoginPlatform) => {
      setBusyKey(p.key);
      try {
        if (p.key === 'instagram') invalidateInstagramSessionCache();
        const remains = await removePlatformCookies(p.cookieDomain);
        const nextConnected = connected.filter((k) => k !== p.key);
        updateSettings({
          connectedPlatforms: nextConnected,
          cookiesPath: remains ? state.settings.cookiesPath : '',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyKey(null);
      }
    },
    [connected, state.settings.cookiesPath, updateSettings]
  );

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <Text style={[styles.cardLabel, { color: theme.text.muted }]}>PLATFORM LOGINS</Text>
      <Text style={[styles.rowSub, { color: theme.text.secondary }]}>
        Sign in to download private, age-restricted, or members-only content. Your
        login stays on this device.
      </Text>
      {error ? (
        <Text style={[styles.rowSub, { color: theme.status.error }]} numberOfLines={2}>
          {error}
        </Text>
      ) : null}

      {LOGIN_PLATFORMS.map((p, i) => {
        const isConnected = connected.includes(p.key);
        const isBusy = busyKey === p.key;
        const sessionDead = p.key === 'instagram' && isConnected && igSession === 'expired';
        return (
          <View
            key={p.key}
            style={[
              styles.row,
              i > 0
                ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border.subtle }
                : null,
            ]}
          >
            <View
              style={[
                styles.iconBox,
                { backgroundColor: isConnected ? theme.status.successDim : theme.accent.subtle },
              ]}
            >
              {isBusy ? (
                <ActivityIndicator size="small" color={theme.accent.primary} />
              ) : isConnected ? (
                <Check size={18} strokeWidth={2.4} color={theme.status.success} />
              ) : (
                <Cookie size={18} strokeWidth={1.8} color={theme.accent.primary} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: theme.text.primary }]}>{p.label}</Text>
              <Text
                style={[
                  styles.rowSub,
                  {
                    color: sessionDead
                      ? theme.status.error
                      : isConnected
                      ? theme.status.success
                      : theme.text.muted,
                  },
                ]}
                numberOfLines={2}
              >
                {sessionDead
                  ? 'Session expired — sign in again'
                  : isConnected
                  ? 'Connected'
                  : p.blurb}
              </Text>
            </View>
            {isConnected ? (
              <Pressable
                disabled={isBusy}
                onPress={() => onLogout(p)}
                style={({ pressed }) => ({
                  paddingHorizontal: spacing.xl,
                  paddingVertical: spacing.md,
                  borderRadius: radius.xs,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.border.subtle,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={[typography.caption, { color: theme.text.secondary, fontWeight: '600' }]}>
                  Log out
                </Text>
              </Pressable>
            ) : (
              <Pressable
                disabled={isBusy}
                onPress={() => navigation.navigate('PlatformLogin', { platform: p.key })}
                style={({ pressed }) => ({
                  paddingHorizontal: spacing.xl,
                  paddingVertical: spacing.md,
                  borderRadius: radius.xs,
                  backgroundColor: theme.accent.primary,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={[typography.caption, { color: theme.accent.onPrimary, fontWeight: '600' }]}>
                  Log in
                </Text>
              </Pressable>
            )}
          </View>
        );
      })}

      <Pressable onPress={onImport} disabled={picking}>
        <Text style={[styles.rowSub, { color: theme.text.muted, marginTop: spacing.sm }]}>
          Import a cookies.txt file for another site →
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
  accentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  accentHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  accentDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
  },
  swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  swatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchAdd: {
    backgroundColor: 'transparent',
    borderStyle: 'dashed',
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
