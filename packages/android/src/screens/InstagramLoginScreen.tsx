import CookieManager from '@react-native-cookies/cookies';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as FileSystem from 'expo-file-system/legacy';
import { X } from 'lucide-react-native';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewNavigation } from 'react-native-webview';

import { RootStackParamList } from '../navigation/types';
import { useDownload } from '../state';
import { spacing, typography, useTheme } from '../theme';

const COOKIES_FILENAME = 'cookies.txt';
const IG_HOME = 'https://www.instagram.com/';
const IG_DOMAIN = 'instagram.com';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Instagram cookie acquisition.
 *
 * yt-dlp's Instagram extractor refuses anonymous reads (Instagram API
 * returns empty media response since 2024). The fix per yt-dlp's own
 * error message: pass authenticated cookies via --cookies.
 *
 * Rather than asking the user to install a browser extension and
 * sideload a cookies.txt file, we open Instagram in an embedded WebView,
 * let them log in normally, then read the resulting session cookies
 * from Android's CookieManager and write a Netscape cookies.txt that
 * yt-dlp consumes.
 *
 * Cookies on instagram.com include httpOnly entries (sessionid, csrftoken)
 * that `document.cookie` can't see — the native CookieManager bridge
 * gives us those.
 */
export function InstagramLoginScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { updateSettings } = useDownload();
  const webRef = useRef<WebView>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Sign in to your Instagram account.');
  const sniffedRef = useRef(false);

  const finish = useCallback(
    async (cookieMap: Record<string, string>) => {
      if (sniffedRef.current) return;
      sniffedRef.current = true;
      setBusy(true);
      setStatus('Saving cookies…');
      try {
        const lines: string[] = ['# Netscape HTTP Cookie File'];
        const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
        for (const [name, value] of Object.entries(cookieMap)) {
          if (!value) continue;
          // domain TAB flag TAB path TAB secure TAB expires TAB name TAB value
          lines.push(['.instagram.com', 'TRUE', '/', 'TRUE', String(expires), name, value].join('\t'));
        }
        const txt = lines.join('\n') + '\n';
        const dest = `${FileSystem.documentDirectory}${COOKIES_FILENAME}`;
        await FileSystem.writeAsStringAsync(dest, txt);
        updateSettings({ cookiesPath: dest.replace(/^file:\/\//, '') });
        setStatus('Cookies saved. Closing…');
        setTimeout(() => navigation.goBack(), 600);
      } catch (e) {
        sniffedRef.current = false;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    },
    [navigation, updateSettings]
  );

  const onNavStateChange = useCallback(
    async (navState: WebViewNavigation) => {
      const url = navState.url;
      // After a successful login Instagram redirects to / or
      // /accounts/onetap/ — both contain instagram.com with no login
      // path. Also pull cookies if the user lands on a profile or feed.
      if (!url.includes(IG_DOMAIN)) return;
      if (sniffedRef.current) return;
      try {
        const all = await CookieManager.get(IG_HOME, true);
        const sessionid = all['sessionid']?.value;
        const ds_user_id = all['ds_user_id']?.value;
        if (sessionid && ds_user_id) {
          const cookieMap: Record<string, string> = {};
          for (const [name, c] of Object.entries(all)) {
            cookieMap[name] = c?.value ?? '';
          }
          await finish(cookieMap);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [finish]
  );

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
            Instagram cookies
          </Text>
          <Text
            style={[
              typography.caption,
              { color: error ? theme.status.error : theme.text.secondary, marginTop: 2 },
            ]}
            numberOfLines={2}
          >
            {error ?? status}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={theme.accent.primary} />
        ) : (
          <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
            <X size={22} strokeWidth={2} color={theme.text.primary} />
          </Pressable>
        )}
      </View>

      <WebView
        ref={webRef}
        source={{ uri: IG_HOME + 'accounts/login/' }}
        style={{ flex: 1 }}
        onNavigationStateChange={onNavStateChange}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        javaScriptEnabled
        incognito={false}
      />
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
});
