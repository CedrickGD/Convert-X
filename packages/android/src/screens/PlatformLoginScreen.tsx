import CookieManager from '@react-native-cookies/cookies';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CheckCircle2, X } from 'lucide-react-native';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewNavigation } from 'react-native-webview';

import { mergePlatformCookies } from '../lib/cookies';
import { LOGIN_USER_AGENT, platformByKey } from '../lib/loginPlatforms';
import { RootStackParamList } from '../navigation/types';
import { useDownload } from '../state';
import { spacing, typography, useTheme } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Rt = RouteProp<RootStackParamList, 'PlatformLogin'>;

/**
 * In-app platform login.
 *
 * yt-dlp needs authenticated cookies for private / age-restricted content.
 * Rather than a browser-extension + cookies.txt dance, we open the
 * platform's own login page in a WebView, let the user sign in normally,
 * then read the resulting session cookies (including httpOnly ones that
 * document.cookie can't see) from Android's CookieManager and merge them
 * into the shared cookies.txt yt-dlp reads.
 */
export function PlatformLoginScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const { updateSettings, state } = useDownload();

  const platform = platformByKey(route.params?.platform ?? '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState(
    platform ? `Sign in to ${platform.label}.` : 'Unknown platform.'
  );
  const sniffedRef = useRef(false);

  const finish = useCallback(
    async (cookieMap: Record<string, string>) => {
      if (!platform || sniffedRef.current) return;
      sniffedRef.current = true;
      setBusy(true);
      setStatus('Saving login…');
      try {
        const path = await mergePlatformCookies(platform.cookieDomain, cookieMap);
        const connected = Array.from(
          new Set([...state.settings.connectedPlatforms, platform.key])
        );
        updateSettings({ cookiesPath: path, connectedPlatforms: connected });
        setBusy(false);
        setDone(true);
        setStatus(`Signed in to ${platform.label}.`);
        setTimeout(() => navigation.goBack(), 750);
      } catch (e) {
        sniffedRef.current = false;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    },
    [navigation, platform, state.settings.connectedPlatforms, updateSettings]
  );

  const onNavStateChange = useCallback(
    async (navState: WebViewNavigation) => {
      if (!platform || sniffedRef.current) return;
      if (!navState.url.includes(platform.cookieDomain.replace(/^\./, ''))) return;
      try {
        const all = await CookieManager.get(platform.cookieOrigin ?? navState.url, true);
        // Login is complete once every required session cookie is present.
        const ready = platform.requiredCookies.every((name) => all[name]?.value);
        if (ready) {
          const cookieMap: Record<string, string> = {};
          for (const [name, c] of Object.entries(all)) cookieMap[name] = c?.value ?? '';
          await finish(cookieMap);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [finish, platform]
  );

  const accent = error ? theme.status.error : done ? theme.status.success : theme.text.secondary;
  // Show the platform caveat (e.g. Google-block) until a real status/error
  // replaces it, so the user isn't surprised if a provider refuses.
  const subline = error ?? (status === `Sign in to ${platform?.label}.` && platform?.note
    ? `${status} ${platform.note}`
    : status);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg.base }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.md,
            paddingHorizontal: spacing.huge,
            paddingBottom: spacing.md,
            borderBottomColor: theme.border.subtle,
          },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={[typography.bodyEmph, { color: theme.text.primary }]}>
            {platform ? `${platform.label} login` : 'Login'}
          </Text>
          <Text style={[typography.caption, { color: accent, marginTop: 2 }]} numberOfLines={3}>
            {subline}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={theme.accent.primary} />
        ) : done ? (
          <CheckCircle2 size={22} strokeWidth={2} color={theme.status.success} />
        ) : (
          <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
            <X size={22} strokeWidth={2} color={theme.text.primary} />
          </Pressable>
        )}
      </View>

      {platform ? (
        <WebView
          source={{ uri: platform.loginUrl }}
          style={{ flex: 1 }}
          onNavigationStateChange={onNavStateChange}
          // Present a real mobile-Chrome UA — the default Android WebView UA
          // makes Google (and others) refuse to render their login page.
          userAgent={LOGIN_USER_AGENT}
          // "Sign in with Google/Apple" buttons open a popup; without this
          // react-native-webview swallows the new window and the tap does
          // nothing. false routes the popup into the main frame instead.
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          domStorageEnabled
          javaScriptEnabled
          incognito={false}
        />
      ) : (
        <View style={styles.emptyBody}>
          <Text style={[typography.body, { color: theme.text.muted, textAlign: 'center' }]}>
            Unknown platform.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  emptyBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.giant },
});
