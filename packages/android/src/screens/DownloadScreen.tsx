import * as Clipboard from 'expo-clipboard';
import { Download as DownloadIcon, Link2 } from 'lucide-react-native';
import React, { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProgressBar } from '../components/convert';
import { detectSite } from '../../modules/convert-x-downloader/src';
import {
  cancelActive,
  DownloadEntry,
  downloadEntry,
  probeUrl,
} from '../lib/downloadQueue';
import { useDownload } from '../state';
import { radius, spacing, typography, useTheme } from '../theme';

const VIDEO_QUALITIES = ['best', '1080', '720', '480', '360'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'wav', 'flac', 'opus'];
const VIDEO_FORMATS = ['best', 'mp4', 'webm'];

/**
 * Download mode — Phase 6.
 *
 * URL input → site chip → category toggle (video / audio) → format picker
 * → probe → preview → download. Progress lives in DownloadContext so the
 * navbar busy-dot reflects in-flight work.
 */
export function DownloadScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const download = useDownload();
  const { state } = download;

  const [url, setUrl] = useState('');
  const [probing, setProbing] = useState(false);
  const [entries, setEntries] = useState<DownloadEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<{ outputPath?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const site = detectSite(url);

  const handlePaste = useCallback(async () => {
    const txt = await Clipboard.getStringAsync();
    if (txt) setUrl(txt.trim());
  }, []);

  const handleProbe = useCallback(async () => {
    if (!url.trim()) return;
    setProbing(true);
    setError(null);
    setEntries([]);
    setDone(null);
    try {
      const result = await probeUrl(url.trim(), {
        spotifyClientId: state.settings.spotifyClientId || undefined,
        spotifyClientSecret: state.settings.spotifyClientSecret || undefined,
        cookies: state.settings.cookiesPath || undefined,
      });
      setEntries(result.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }, [url, state.settings]);

  const handleDownload = useCallback(async () => {
    if (entries.length === 0) return;
    setError(null);
    setDone(null);
    setProgress(0);
    const sessionId = `dl-${Date.now()}`;
    download.dispatch({ type: 'beginSession', sessionId });
    try {
      const result = await downloadEntry({
        sessionId,
        entry: entries[0],
        audioOnly: state.settings.category === 'audio',
        format: state.settings.format,
        quality: state.settings.quality,
        spotifyClientId: state.settings.spotifyClientId || undefined,
        spotifyClientSecret: state.settings.spotifyClientSecret || undefined,
        cookies: state.settings.cookiesPath || undefined,
        onProgress: setProgress,
      });
      if (result.cancelled) {
        download.dispatch({ type: 'cancelSession' });
      } else {
        setDone({ outputPath: result.outputPath });
        download.dispatch({ type: 'finishSession', sessionId });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      download.dispatch({ type: 'cancelSession' });
    }
  }, [download, entries, state.settings]);

  const handleCancel = useCallback(() => {
    cancelActive();
    download.dispatch({ type: 'cancelSession' });
  }, [download]);

  const handleReset = useCallback(() => {
    setUrl('');
    setEntries([]);
    setDone(null);
    setError(null);
    setProgress(0);
    download.reset();
  }, [download]);

  const busy = state.view === 'converting';
  const showInput = state.view === 'idle' && entries.length === 0;
  const showPreview = entries.length > 0 && state.view !== 'converting' && !done;
  const showProgress = state.view === 'converting';
  const showDone = done !== null;

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.giant }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {showInput ? (
        <View style={styles.stack}>
          {/* URL input card */}
          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
            ]}
          >
            <Text style={[styles.cardLabel, { color: theme.text.muted }]}>URL</Text>
            <View
              style={[
                styles.urlRow,
                {
                  backgroundColor: theme.bg.surfaceSunken,
                  borderColor: theme.border.subtle,
                },
              ]}
            >
              <Link2 size={16} strokeWidth={1.8} color={theme.text.muted} />
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="https://youtube.com/..."
                placeholderTextColor={theme.text.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[styles.urlInput, { color: theme.text.primary }]}
              />
              <Pressable
                onPress={handlePaste}
                style={({ pressed }) => [
                  styles.pasteBtn,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Text style={[styles.pasteText, { color: theme.accent.primary }]}>Paste</Text>
              </Pressable>
            </View>
            {site ? (
              <View
                style={[
                  styles.siteChip,
                  { backgroundColor: theme.accent.subtle, borderColor: theme.accent.dim },
                ]}
              >
                <Text style={[styles.siteChipText, { color: theme.accent.primary }]}>
                  {site}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Category + format + quality */}
          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
            ]}
          >
            <Text style={[styles.cardLabel, { color: theme.text.muted }]}>CATEGORY</Text>
            <View style={styles.toggle}>
              <ToggleBtn
                label="Video"
                active={state.settings.category === 'video'}
                onPress={() => download.updateSettings({ category: 'video', format: null })}
              />
              <ToggleBtn
                label="Audio"
                active={state.settings.category === 'audio'}
                onPress={() => download.updateSettings({ category: 'audio', format: null })}
              />
            </View>

            <Text style={[styles.cardLabel, { color: theme.text.muted, marginTop: spacing.md }]}>
              FORMAT
            </Text>
            <View style={styles.chipRow}>
              {(state.settings.category === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS).map((f) => (
                <Chip
                  key={f}
                  label={f.toUpperCase()}
                  selected={state.settings.format === f || (state.settings.format === null && f === (state.settings.category === 'video' ? 'best' : 'mp3'))}
                  onPress={() => download.updateSettings({ format: f })}
                />
              ))}
            </View>

            {state.settings.category === 'video' ? (
              <>
                <Text style={[styles.cardLabel, { color: theme.text.muted, marginTop: spacing.md }]}>
                  MAX QUALITY
                </Text>
                <View style={styles.chipRow}>
                  {VIDEO_QUALITIES.map((q) => (
                    <Chip
                      key={q}
                      label={q === 'best' ? 'Best' : `${q}p`}
                      selected={state.settings.quality === q}
                      onPress={() => download.updateSettings({ quality: q })}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </View>

          {/* Probe button */}
          <View style={styles.actions}>
            <Pressable
              onPress={handleProbe}
              disabled={!url.trim() || probing}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: theme.accent.primary,
                  opacity: !url.trim() || probing ? 0.3 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                {probing ? 'Loading…' : 'Find'}
              </Text>
            </Pressable>
          </View>

          {error ? (
            <Text style={[styles.errorText, { color: theme.status.error }]}>{error}</Text>
          ) : null}
        </View>
      ) : null}

      {showPreview ? (
        <View style={styles.stack}>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
            ]}
          >
            <Text style={[styles.cardLabel, { color: theme.text.muted }]}>
              {entries.length > 1 ? `${entries.length} ITEMS` : 'ITEM'}
            </Text>
            {entries.slice(0, 5).map((e) => (
              <View key={e.id} style={styles.entryRow}>
                <View style={[styles.dot, { backgroundColor: theme.accent.primary }]} />
                <Text
                  numberOfLines={2}
                  style={[styles.entryTitle, { color: theme.text.primary }]}
                >
                  {e.title}
                </Text>
              </View>
            ))}
            {entries.length > 5 ? (
              <Text style={[styles.moreText, { color: theme.text.muted }]}>
                +{entries.length - 5} more
              </Text>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={handleReset}
              style={({ pressed }) => [
                styles.ghostBtn,
                { borderColor: theme.border.subtle, backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent' },
              ]}
            >
              <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>Back</Text>
            </Pressable>
            <Pressable
              onPress={handleDownload}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: theme.accent.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <DownloadIcon size={14} strokeWidth={2} color={theme.accent.onPrimary} />
              <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                Download
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showProgress ? (
        <View style={styles.stack}>
          <ProgressBar progress={progress} label="Downloading…" />
          <View style={styles.actions}>
            <Pressable
              onPress={handleCancel}
              style={({ pressed }) => [
                styles.ghostBtn,
                { borderColor: theme.border.subtle, backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent' },
              ]}
            >
              <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showDone ? (
        <View style={styles.stack}>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle, alignItems: 'center' },
            ]}
          >
            <View style={[styles.iconRing, { backgroundColor: theme.accent.subtle }]}>
              <DownloadIcon size={28} strokeWidth={2.2} color={theme.accent.primary} />
            </View>
            <Text style={[styles.doneTitle, { color: theme.text.primary }]}>Downloaded</Text>
            <Text style={[styles.doneSub, { color: theme.text.muted }]} numberOfLines={2}>
              {done?.outputPath ?? ''}
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={handleReset}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: theme.accent.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                Download more
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {!showInput && !showPreview && !showProgress && !showDone ? (
        <Text style={[styles.errorText, { color: theme.text.muted }]}>
          {busy ? 'Working…' : 'Tap a tab to start.'}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function ToggleBtn({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.toggleBtn,
        {
          backgroundColor: active ? theme.bg.surface : 'transparent',
          opacity: pressed && !active ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.toggleBtnText,
          { color: active ? theme.text.primary : theme.text.muted },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? theme.accent.primary : theme.bg.secondary,
          borderColor: selected ? theme.accent.primary : theme.border.subtle,
          opacity: pressed && !selected ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: selected ? theme.accent.onPrimary : theme.text.secondary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.md,
    gap: spacing.xl,
    flexGrow: 1,
  },
  stack: { gap: spacing.xl },
  card: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  cardLabel: { ...typography.micro, letterSpacing: 0.6 },

  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  urlInput: { flex: 1, ...typography.bodySm, paddingVertical: 0 },
  pasteBtn: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  pasteText: { ...typography.caption, fontWeight: '600' },

  siteChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
  },
  siteChipText: { ...typography.micro, fontWeight: '600' },

  toggle: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: radius.xs,
    backgroundColor: 'transparent',
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.xs - 2,
    alignItems: 'center',
  },
  toggleBtnText: { ...typography.caption, fontWeight: '600' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico },
  chip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { ...typography.caption, fontWeight: '600' },

  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingTop: spacing.sm,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    paddingHorizontal: spacing.hugeAlt,
    borderRadius: radius.sm,
  },
  primaryBtnText: { ...typography.body, fontWeight: '600' },
  ghostBtn: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.giant,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghostBtnText: { ...typography.body, fontWeight: '600' },

  entryRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  entryTitle: { ...typography.body, flex: 1 },
  moreText: { ...typography.caption, paddingLeft: spacing.huge },

  iconRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneTitle: { ...typography.titleAlt },
  doneSub: { ...typography.caption, textAlign: 'center' },

  errorText: { ...typography.caption, textAlign: 'center' },
});
