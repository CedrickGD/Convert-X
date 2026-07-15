import * as Clipboard from 'expo-clipboard';
import { Check, Download as DownloadIcon, Image as ImageIcon, Link2, Music, Share2, Video } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { ProgressBar } from '../components/convert';
import { useFeedback } from '../components/Feedback';
import { detectSite } from '../../modules/convert-x-downloader/src';
import {
  cancelBatch,
  DownloadEntry,
  downloadBatch,
  probeUrl,
  updateYtDlp,
} from '../lib/downloadQueue';
import type { RootStackParamList } from '../navigation/types';
import { addHistoryEntry } from '../lib/history';
import { addRecentUrl, getRecentUrls } from '../lib/recentUrls';
import { useDownload, useShared } from '../state';
import { radius, spacing, typography, useTheme } from '../theme';

const VIDEO_QUALITIES = ['best', '1080', '720', '480', '360'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'wav', 'flac', 'opus'];

/**
 * Download mode — Phase 6.
 *
 * URL input → site chip → category toggle (video / audio) → format picker
 * → probe → preview → download. Progress lives in DownloadContext so the
 * navbar busy-dot reflects in-flight work.
 */
export function DownloadScreen() {
  const { theme } = useTheme();
  const { toast } = useFeedback();
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
  const [results, setResults] = useState<{ name: string; uri: string }[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [engineUpdating, setEngineUpdating] = useState(false);

  const site = detectSite(url);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Route the two recoverable yt-dlp failures to their in-app fixes.
  // Without these buttons, users are left with yt-dlp's CLI advice
  // ("use --cookies", "yt-dlp -U") that they cannot act on in an app.
  const needsLogin =
    !!error &&
    site === 'Instagram' &&
    /login required|cookies|empty media response|restricted|private|rate.?limit/i.test(error);
  const suggestsEngineUpdate =
    !!error && /yt-dlp -U|latest version|unsupported url|Confirm you are on/i.test(error);

  const handleEngineUpdate = useCallback(async () => {
    setEngineUpdating(true);
    try {
      const result = await updateYtDlp();
      if (result.ok) {
        const version = result.version ? ` (${result.version})` : '';
        toast(
          result.status === 'ALREADY_UP_TO_DATE'
            ? `Engine already up to date${version}`
            : `Engine updated${version} — tap Find to retry`,
          result.status === 'ALREADY_UP_TO_DATE' ? 'info' : 'success'
        );
      } else {
        toast(result.error ?? 'Could not update the download engine.', 'error');
      }
    } finally {
      setEngineUpdating(false);
    }
  }, [toast]);

  useEffect(() => {
    getRecentUrls().then(setRecent);
  }, []);

  const handleShareItem = useCallback(async (uri: string) => {
    if (!(await Sharing.isAvailableAsync())) return;
    await Sharing.shareAsync(uri).catch(() => {});
  }, []);

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
      void addRecentUrl(trimmed).then(setRecent);
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
  const partialCarousel = entries.some((e) => e.partialCarousel);

  const runDownload = useCallback(
    async (toDownload: DownloadEntry[]) => {
      if (toDownload.length === 0) return;
      setError(null);
      setDone(null);
      setResults([]);
      setProgress(0);
      setCurrentItemIdx(0);
      setCurrentItemTitle(toDownload[0]?.title ?? null);

      // No permission gate: the gallery save is a MediaStore insert the
      // app owns, which Android allows without any permission or dialog.

      const sessionId = `dl-${Date.now()}`;
      download.dispatch({ type: 'beginSession', sessionId });
      try {
        const result = await downloadBatch({
          sessionId,
          entries: toDownload,
          audioOnly: state.settings.category === 'audio',
          format: state.settings.format,
          quality: state.settings.quality,
          spotifyClientId: state.settings.spotifyClientId || undefined,
          spotifyClientSecret: state.settings.spotifyClientSecret || undefined,
          cookies: state.settings.cookiesPath || undefined,
          saveToGallery: true,
          onProgress: (overall, idx) => {
            setProgress(overall);
            setCurrentItemIdx(idx);
          },
          onItemStart: (idx, entry) => {
            setCurrentItemIdx(idx);
            setCurrentItemTitle(entry.title);
          },
          onItemDone: (entry, r) => {
            const path = r.outputPath
              ? r.outputPath.startsWith('file://')
                ? r.outputPath
                : `file://${r.outputPath}`
              : r.publicPath;
            if (!path) return;
            const name = r.outputPath?.split('/').pop() ?? entry.title;
            setResults((prev) => [...prev, { name, uri: path }]);
            void addHistoryEntry({ uri: path, name, bytes: 0, op: 'download', source: entry.webpageUrl });
          },
        });
        if (result.cancelled) {
          download.dispatch({ type: 'cancelSession' });
        } else {
          setDone({
            publicPath: result.lastPublicPath,
            completed: result.done,
            total: toDownload.length,
            errors: result.errors,
          });
          download.dispatch({ type: 'finishSession', sessionId });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        download.dispatch({ type: 'cancelSession' });
      }
    },
    [download, state.settings]
  );

  const handleDownload = useCallback(
    () => runDownload(selectedEntries),
    [runDownload, selectedEntries]
  );

  // Re-run only the items that failed last time, preserving prior successes.
  const handleRetryFailed = useCallback(() => {
    const failedTitles = new Set((done?.errors ?? []).map((e) => e.title));
    const failed = entries.filter((e) => failedTitles.has(e.title));
    if (failed.length > 0) runDownload(failed);
  }, [done, entries, runDownload]);

  const handleCancel = useCallback(() => {
    cancelBatch();
    download.dispatch({ type: 'cancelSession' });
  }, [download]);

  const handleReset = useCallback(() => {
    setUrl('');
    setEntries([]);
    setSelectedIds(new Set());
    setDone(null);
    setResults([]);
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

  // What did the probe actually find among the SELECTED items? This drives
  // the adaptive options: a photo post must never offer a "video/audio"
  // choice, and an audio-only source must never offer a quality ladder.
  const selectedKinds = useMemo(() => {
    const src = selectedEntries.length > 0 ? selectedEntries : entries;
    return {
      hasVideo: src.some((e) => (e.mediaType ?? 'video') === 'video'),
      hasAudioSource: src.some((e) => e.mediaType === 'audio'),
      allImages: src.length > 0 && src.every((e) => e.mediaType === 'image'),
    };
  }, [selectedEntries, entries]);

  // Photos are "saved", media is "downloaded" — small wording that makes
  // the button match what the user actually sees on screen.
  const actionVerb = selectedKinds.allImages ? 'Save' : 'Download';

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

          {recent.length > 0 && !url ? (
            <View style={styles.recentRow}>
              {recent.map((u) => (
                <Pressable
                  key={u}
                  onPress={() => setUrl(u)}
                  accessibilityRole="button"
                  accessibilityLabel={`Use recent URL ${u}`}
                  style={({ pressed }) => [
                    styles.recentChip,
                    {
                      borderColor: theme.border.subtle,
                      backgroundColor: pressed ? theme.bg.surfaceHigh : theme.bg.surface,
                    },
                  ]}
                >
                  <Text numberOfLines={1} style={[styles.recentChipText, { color: theme.text.muted }]}>
                    {shortUrl(u)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* Options come AFTER the probe now — we can't know whether this
              URL is a video, an audio track, or a photo post until yt-dlp
              tells us, so asking "video or audio?" up front is wrong. */}

          {/* Find button */}
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
              {probing ? (
                <ActivityIndicator size="small" color={theme.accent.onPrimary} />
              ) : (
                <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                  Find
                </Text>
              )}
            </Pressable>
          </View>

          {error ? (
            <View style={styles.errorBlock}>
              <Text style={[styles.errorText, { color: theme.status.error }]}>{error}</Text>
              {needsLogin ? (
                <Pressable
                  onPress={() => navigation.navigate('PlatformLogin', { platform: 'instagram' })}
                  style={({ pressed }) => [
                    styles.errorAction,
                    { backgroundColor: theme.accent.primary, opacity: pressed ? 0.85 : 1 },
                  ]}
                >
                  <Text style={[styles.errorActionText, { color: theme.accent.onPrimary }]}>
                    Log in to Instagram
                  </Text>
                </Pressable>
              ) : null}
              {suggestsEngineUpdate ? (
                <Pressable
                  disabled={engineUpdating}
                  onPress={handleEngineUpdate}
                  style={({ pressed }) => [
                    styles.errorAction,
                    {
                      backgroundColor: theme.accent.primary,
                      opacity: engineUpdating ? 0.5 : pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  {engineUpdating ? (
                    <ActivityIndicator size="small" color={theme.accent.onPrimary} />
                  ) : (
                    <Text style={[styles.errorActionText, { color: theme.accent.onPrimary }]}>
                      Update download engine
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>
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
            {partialCarousel ? (
              <Text style={[styles.carouselNotice, { color: theme.status.warning }]}>
                Only the first item is available without login. Sign in via
                Credits → Login for the full carousel.
              </Text>
            ) : null}
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
                      <ExpoImage
                        source={{ uri: e.thumbnail }}
                        style={[
                          styles.thumbnail,
                          { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
                        ]}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        recyclingKey={e.id}
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

          {/* Adaptive options — shaped by what the probe actually found. */}
          {selectedEntries.length > 0 ? (
            <View
              style={[
                styles.card,
                { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
              ]}
            >
              {selectedKinds.hasVideo ? (
                <>
                  <Text style={[styles.cardLabel, { color: theme.text.muted }]}>
                    DOWNLOAD AS
                  </Text>
                  <View
                    style={[
                      styles.toggle,
                      { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
                    ]}
                  >
                    <ToggleBtn
                      icon={Video}
                      label="Video"
                      active={state.settings.category === 'video'}
                      onPress={() => download.updateSettings({ category: 'video', format: null })}
                    />
                    <ToggleBtn
                      icon={Music}
                      label="Audio"
                      active={state.settings.category === 'audio'}
                      onPress={() => download.updateSettings({ category: 'audio', format: null })}
                    />
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
                  ) : (
                    <>
                      <Text style={[styles.cardLabel, { color: theme.text.muted, marginTop: spacing.md }]}>
                        AUDIO FORMAT
                      </Text>
                      <View style={styles.chipRow}>
                        {AUDIO_FORMATS.map((f) => (
                          <Chip
                            key={f}
                            label={f.toUpperCase()}
                            selected={state.settings.format === f || (state.settings.format === null && f === 'mp3')}
                            onPress={() => download.updateSettings({ format: f })}
                          />
                        ))}
                      </View>
                    </>
                  )}
                </>
              ) : selectedKinds.hasAudioSource ? (
                <>
                  <Text style={[styles.cardLabel, { color: theme.text.muted }]}>
                    AUDIO FORMAT
                  </Text>
                  <View style={styles.chipRow}>
                    {AUDIO_FORMATS.map((f) => (
                      <Chip
                        key={f}
                        label={f.toUpperCase()}
                        selected={state.settings.format === f || (state.settings.format === null && f === 'mp3')}
                        onPress={() => download.updateSettings({ format: f })}
                      />
                    ))}
                  </View>
                </>
              ) : (
                <View style={styles.optionsInfoRow}>
                  <ImageIcon size={16} strokeWidth={1.8} color={theme.text.muted} />
                  <Text style={[styles.optionsInfoText, { color: theme.text.muted }]}>
                    {selectedEntries.length > 1
                      ? 'Photos download at full resolution.'
                      : 'Photo downloads at full resolution.'}
                  </Text>
                </View>
              )}
            </View>
          ) : null}

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
                {actionVerb}
                {selectedEntries.length > 1 ? ` ${selectedEntries.length}` : ''}
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
          {results.length > 0 ? (
            <View style={[styles.card, { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle }]}>
              {results.map((res, i) => {
                // No save button here: the download already saved this file
                // to the gallery. Offering "save" again wrote a duplicate.
                // Share works off the app-private copy that stays on disk.
                return (
                  <View
                    key={i}
                    style={[
                      styles.resultRow,
                      i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border.subtle } : null,
                    ]}
                  >
                    <View style={styles.resultInfo}>
                      <Text numberOfLines={1} style={[styles.resultName, { color: theme.text.primary }]}>
                        {res.name}
                      </Text>
                      <View style={styles.resultSavedRow}>
                        <Check size={11} strokeWidth={3} color={theme.status.success} />
                        <Text style={[styles.resultSaved, { color: theme.text.muted }]}>
                          Saved to gallery
                        </Text>
                      </View>
                    </View>
                    <Pressable
                      hitSlop={6}
                      onPress={() => handleShareItem(res.uri)}
                      accessibilityRole="button"
                      accessibilityLabel={`Share ${res.name}`}
                      style={({ pressed }) => [
                        styles.resultIconBtn,
                        { borderColor: theme.border.subtle, backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent' },
                      ]}
                    >
                      <Share2 size={14} strokeWidth={2} color={theme.text.secondary} />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : null}
          <View style={styles.actions}>
            {done && done.errors.length > 0 ? (
              <Pressable
                onPress={handleRetryFailed}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.ghostBtn,
                  { borderColor: theme.border.subtle, backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent' },
                ]}
              >
                <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>
                  Retry failed ({done.errors.length})
                </Text>
              </Pressable>
            ) : null}
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

/** Strip scheme/www and truncate for a compact recent-URL chip. */
function shortUrl(u: string): string {
  return u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 26);
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
  icon: Icon,
  label,
  active,
  onPress,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; color?: string }>;
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
          backgroundColor: active ? theme.accent.primary : 'transparent',
          opacity: pressed && !active ? 0.7 : 1,
          elevation: active ? 2 : 0,
        },
      ]}
    >
      <Icon
        size={15}
        strokeWidth={2}
        color={active ? theme.accent.onPrimary : theme.text.secondary}
      />
      <Text
        style={[
          styles.toggleBtnText,
          { color: active ? theme.accent.onPrimary : theme.text.secondary },
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
    gap: spacing.xs,
    padding: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: radius.xs,
  },
  toggleBtnText: { ...typography.bodySm, fontWeight: '600' },

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
  optionsInfoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionsInfoText: { ...typography.caption, flex: 1 },
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
  errorBlock: { gap: spacing.md, alignItems: 'center' },
  errorAction: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    minWidth: 200,
    alignItems: 'center',
  },
  errorActionText: { ...typography.body, fontWeight: '600' },
  carouselNotice: { ...typography.caption, lineHeight: 17 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  resultName: { ...typography.bodySm },
  resultInfo: { flex: 1, gap: 2 },
  resultSavedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  resultSaved: { ...typography.micro },
  resultActions: { flexDirection: 'row', gap: spacing.sm },
  recentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  recentChip: {
    maxWidth: '100%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
  },
  recentChipText: { ...typography.micro },
  resultIconBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
