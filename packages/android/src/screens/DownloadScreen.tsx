import * as Clipboard from 'expo-clipboard';
import { Check, Download as DownloadIcon, Link2 } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
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
  cancelBatch,
  DownloadEntry,
  downloadBatch,
  ensureMediaPermission,
  probeUrl,
} from '../lib/downloadQueue';
import { useDownload, useShared } from '../state';
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState(0);
  const [currentItemIdx, setCurrentItemIdx] = useState(0);
  const [currentItemTitle, setCurrentItemTitle] = useState<string | null>(null);
  const [done, setDone] = useState<{
    publicPath?: string;
    completed: number;
    total: number;
    errors: Array<{ title: string; message: string }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const site = detectSite(url);

  // Clear the URL search when the user leaves the Download tab — unless a
  // probe / download / completed session is sitting on screen. Lets them
  // come back fresh after pasting a one-off link, but preserves real work.
  const { activeMode } = useShared();
  const prevModeRef = useRef(activeMode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = activeMode;
    if (prev === 'download' && activeMode !== 'download') {
      const inProgress =
        state.view === 'converting' ||
        entries.length > 0 ||
        probing ||
        done !== null;
      if (!inProgress) {
        setUrl('');
        setError(null);
      }
    }
  }, [activeMode, state.view, entries.length, probing, done]);

  const handlePaste = useCallback(async () => {
    const txt = await Clipboard.getStringAsync();
    if (txt) setUrl(txt.trim());
  }, []);

  const handleProbe = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setProbing(true);
    setError(null);
    setEntries([]);
    setSelectedIds(new Set());
    setDone(null);
    try {
      // Pluck an Instagram-style hint that asks for a specific carousel
      // item ("?img_index=9" → item index 9, zero-based). yt-dlp ignores
      // the param itself, so we keep it on the URL we send but use it
      // locally to default the selection.
      const hintMatch = trimmed.match(/[?&]img_index=(\d+)/);
      const hintIdx = hintMatch ? parseInt(hintMatch[1], 10) : -1;

      const result = await probeUrl(trimmed, {
        spotifyClientId: state.settings.spotifyClientId || undefined,
        spotifyClientSecret: state.settings.spotifyClientSecret || undefined,
        cookies: state.settings.cookiesPath || undefined,
      });
      setEntries(result.entries);
      // If the URL targeted a specific carousel item (Instagram does
      // this when you tap a single image in a post), default the
      // selection to JUST that item. User can tap "Select all" to
      // promote to the whole post.
      if (hintIdx >= 0 && hintIdx < result.entries.length) {
        setSelectedIds(new Set([result.entries[hintIdx].id]));
      } else {
        setSelectedIds(new Set(result.entries.map((e) => e.id)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }, [url, state.settings]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selectedIds.has(e.id)),
    [entries, selectedIds]
  );

  const allSelected = entries.length > 0 && selectedIds.size === entries.length;

  const handleDownload = useCallback(async () => {
    if (selectedEntries.length === 0) return;
    setError(null);
    setDone(null);
    setProgress(0);
    setCurrentItemIdx(0);
    setCurrentItemTitle(selectedEntries[0]?.title ?? null);

    // Ask for permission up-front. If the user denies, we still download
    // to app-private storage — but we tell them so they're not surprised
    // when the file isn't in their Gallery afterwards.
    const granted = await ensureMediaPermission();
    if (!granted) {
      const proceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Save to Gallery?',
          'Without this permission, downloads stay inside Convert-X and won’t show up in your Gallery or Files app. Continue with a private download?',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Continue', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) }
        );
      });
      if (!proceed) return;
    }

    const sessionId = `dl-${Date.now()}`;
    download.dispatch({ type: 'beginSession', sessionId });
    try {
      const result = await downloadBatch({
        sessionId,
        entries: selectedEntries,
        audioOnly: state.settings.category === 'audio',
        format: state.settings.format,
        quality: state.settings.quality,
        spotifyClientId: state.settings.spotifyClientId || undefined,
        spotifyClientSecret: state.settings.spotifyClientSecret || undefined,
        cookies: state.settings.cookiesPath || undefined,
        saveToGallery: granted,
        onProgress: (overall, idx) => {
          setProgress(overall);
          setCurrentItemIdx(idx);
        },
        onItemStart: (idx, entry) => {
          setCurrentItemIdx(idx);
          setCurrentItemTitle(entry.title);
        },
      });
      if (result.cancelled) {
        download.dispatch({ type: 'cancelSession' });
      } else {
        setDone({
          publicPath: result.lastPublicPath,
          completed: result.done,
          total: selectedEntries.length,
          errors: result.errors,
        });
        download.dispatch({ type: 'finishSession', sessionId });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      download.dispatch({ type: 'cancelSession' });
    }
  }, [download, selectedEntries, state.settings]);

  const handleCancel = useCallback(() => {
    cancelBatch();
    download.dispatch({ type: 'cancelSession' });
  }, [download]);

  const handleReset = useCallback(() => {
    setUrl('');
    setEntries([]);
    setSelectedIds(new Set());
    setDone(null);
    setError(null);
    setProgress(0);
    setCurrentItemIdx(0);
    setCurrentItemTitle(null);
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
            <View style={styles.previewHeader}>
              <Text style={[styles.cardLabel, { color: theme.text.muted }]}>
                {entries.length > 1
                  ? `${selectedIds.size} of ${entries.length} selected`
                  : 'PREVIEW'}
              </Text>
              {entries.length > 1 ? (
                <Pressable
                  onPress={() =>
                    setSelectedIds(
                      allSelected ? new Set() : new Set(entries.map((e) => e.id))
                    )
                  }
                  hitSlop={6}
                >
                  <Text style={[styles.selectAllText, { color: theme.accent.primary }]}>
                    {allSelected ? 'Select none' : 'Select all'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {entries.map((e, idx) => {
              const isSelected = selectedIds.has(e.id);
              const multi = entries.length > 1;
              return (
                <Pressable
                  key={e.id}
                  onPress={multi ? () => toggleSelected(e.id) : undefined}
                  style={({ pressed }) => [
                    styles.previewRow,
                    { opacity: multi && !isSelected ? 0.45 : pressed ? 0.85 : 1 },
                  ]}
                >
                  {multi ? (
                    <View
                      style={[
                        styles.checkbox,
                        {
                          backgroundColor: isSelected ? theme.accent.primary : 'transparent',
                          borderColor: isSelected ? theme.accent.primary : theme.border.subtle,
                        },
                      ]}
                    >
                      {isSelected ? (
                        <Check size={14} strokeWidth={3} color={theme.accent.onPrimary} />
                      ) : null}
                    </View>
                  ) : null}
                  <View style={styles.thumbWrap}>
                    {e.thumbnail ? (
                      <Image
                        source={{ uri: e.thumbnail }}
                        style={[
                          styles.thumbnail,
                          { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
                        ]}
                        resizeMode="cover"
                      />
                    ) : (
                      <View
                        style={[
                          styles.thumbnail,
                          styles.thumbnailFallback,
                          { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
                        ]}
                      >
                        <Link2 size={20} strokeWidth={1.8} color={theme.text.muted} />
                      </View>
                    )}
                    {multi ? (
                      <View
                        style={[
                          styles.posBadge,
                          { backgroundColor: 'rgba(0,0,0,0.7)' },
                        ]}
                      >
                        <Text style={styles.posBadgeText}>
                          {idx + 1}/{entries.length}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.previewBody}>
                    <Text
                      numberOfLines={2}
                      style={[styles.previewTitle, { color: theme.text.primary }]}
                    >
                      {e.title}
                    </Text>
                    {e.duration ? (
                      <Text style={[styles.previewMeta, { color: theme.text.muted }]}>
                        {formatDuration(e.duration)}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
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
              disabled={selectedEntries.length === 0}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: theme.accent.primary,
                  opacity: selectedEntries.length === 0 ? 0.3 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <DownloadIcon size={14} strokeWidth={2} color={theme.accent.onPrimary} />
              <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                {selectedEntries.length > 1
                  ? `Download ${selectedEntries.length}`
                  : 'Download'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showProgress ? (
        <View style={styles.stack}>
          <ProgressBar
            progress={progress}
            label={
              selectedEntries.length > 1
                ? `Item ${currentItemIdx + 1} of ${selectedEntries.length}`
                : 'Downloading…'
            }
          />
          {currentItemTitle ? (
            <Text
              numberOfLines={1}
              style={[styles.currentItem, { color: theme.text.muted }]}
            >
              {currentItemTitle}
            </Text>
          ) : null}
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
            <Text style={[styles.doneTitle, { color: theme.text.primary }]}>
              {done?.total && done.total > 1
                ? `${done.completed} of ${done.total} downloaded`
                : 'Downloaded'}
            </Text>
            <Text style={[styles.doneSub, { color: theme.text.muted }]} numberOfLines={2}>
              {done?.publicPath
                ? 'Saved to Gallery · Convert-X album'
                : 'Saved inside Convert-X'}
            </Text>
            {done?.errors && done.errors.length > 0 ? (
              <View style={styles.doneErrors}>
                <Text style={[styles.doneErrorsLabel, { color: theme.status.error }]}>
                  {done.errors.length} failed
                </Text>
                {done.errors.slice(0, 3).map((err, i) => (
                  <Text
                    key={i}
                    numberOfLines={2}
                    style={[styles.doneErrorItem, { color: theme.text.muted }]}
                  >
                    {err.title}: {err.message}
                  </Text>
                ))}
              </View>
            ) : null}
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

/** Format a yt-dlp duration (seconds) into a short clock string. */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
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

  previewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  selectAllText: { ...typography.caption, fontWeight: '600' },
  previewRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  currentItem: {
    ...typography.caption,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  doneErrors: { alignSelf: 'stretch', marginTop: spacing.lg, gap: spacing.xs },
  doneErrorsLabel: { ...typography.caption, fontWeight: '600' },
  doneErrorItem: { ...typography.micro },
  thumbWrap: {
    width: 96,
    height: 54,
    position: 'relative',
  },
  thumbnail: {
    width: 96,
    height: 54,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  thumbnailFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  posBadge: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  posBadgeText: {
    ...typography.micro,
    color: '#fff',
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  previewBody: { flex: 1, gap: 2 },
  previewTitle: { ...typography.body },
  previewMeta: { ...typography.caption, fontVariant: ['tabular-nums'] },
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
