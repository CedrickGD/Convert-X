import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Dropzone,
  FileList,
  FilePreview,
  FormatPicker,
  OutputPanel,
  OutputSettings,
  ProgressBar,
} from '../components/convert';
import { MediaType, mediaTypeFromName } from '../lib/formats';
import { cancelSession, runConvertSession } from '../lib/conversionQueue';
import { useConvert } from '../state';
import { FileEntry } from '../state/types';
import { radius, spacing, typography, useTheme } from '../theme';

/**
 * Convert mode — Phase 3 visual port.
 *
 * The actual conversion path is still image-only via expo-image-manipulator
 * (lands FFmpeg in Phase 4). What's new in Phase 3 is the UI: every visible
 * element now comes from the ported Convert-X desktop component set in
 * src/components/convert/. ClipEditor + GifSettings + AdvancedSettings ship
 * in Phase 4 alongside the video pipeline.
 */
export function ConvertScreen() {
  const { theme } = useTheme();
  const convert = useConvert();
  const insets = useSafeAreaInsets();
  const { state } = convert;

  const handlePickFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // Phase 4 unlocks video + audio via FFmpeg.
        type: ['image/*', 'video/*', 'audio/*'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const entries: FileEntry[] = result.assets.map((a, i) => ({
        id: `${Date.now()}-${i}-${a.name}`,
        uri: a.uri,
        name: a.name,
        bytes: a.size ?? 0,
        mediaType: mediaTypeFromName(a.name),
        status: 'ready',
        progress: 0,
      }));
      convert.addFiles(entries);
    } catch (e) {
      Alert.alert('Pick failed', e instanceof Error ? e.message : String(e));
    }
  }, [convert]);

  const handlePickFromGallery = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Grant access to your photos to pick from gallery.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      quality: 1,
      exif: false,
    });
    if (result.canceled || !result.assets?.length) return;
    const entries: FileEntry[] = result.assets.map((a, i) => {
      const isVideo = a.type === 'video';
      return {
        id: `${Date.now()}-${i}-${a.fileName ?? 'media'}`,
        uri: a.uri,
        name: a.fileName ?? `media-${i}.${isVideo ? 'mp4' : 'jpg'}`,
        bytes: a.fileSize ?? 0,
        mediaType: (isVideo ? 'video' : 'image') as MediaType,
        width: a.width,
        height: a.height,
        status: 'ready',
        progress: 0,
      };
    });
    convert.addFiles(entries);
  }, [convert]);

  const handleStartConvert = useCallback(() => {
    const fmt = state.settings.format;
    if (!fmt) {
      Alert.alert('Pick a format', 'Choose a target format first.');
      return;
    }
    if (state.files.length === 0) return;
    const sessionId = convert.beginSession();
    runConvertSession({
      sessionId,
      files: state.files,
      targetFormatKey: fmt,
      quality: state.settings.quality,
      onFileStart: (id) =>
        convert.dispatch({ type: 'fileStatus', sessionId, id, status: 'converting', progress: 0 }),
      onFileProgress: (id, progress) =>
        convert.dispatch({ type: 'fileProgress', sessionId, id, progress }),
      onFileDone: (id, outputUri, outputName, outputBytes) =>
        convert.dispatch({
          type: 'fileResult',
          sessionId,
          id,
          outputUri,
          outputName,
          outputBytes,
        }),
      onFileError: (id, error) => convert.dispatch({ type: 'fileError', sessionId, id, error }),
      onFileSkipped: (id) =>
        convert.dispatch({ type: 'fileStatus', sessionId, id, status: 'skipped' }),
    }).finally(() => convert.dispatch({ type: 'finishSession', sessionId }));
  }, [convert, state.files, state.settings]);

  const handleCancel = useCallback(() => {
    if (state.currentSessionId) cancelSession(state.currentSessionId);
    convert.cancel();
  }, [convert, state.currentSessionId]);

  // Derived values
  const sourceTypes = useMemo(() => {
    const s = new Set<MediaType>();
    state.files.forEach((f) => s.add(f.mediaType));
    return s;
  }, [state.files]);

  const isBatch = state.files.length > 1;
  const single = state.files[0];
  const overallProgress = useMemo(() => {
    const active = state.files.filter((f) => f.status !== 'skipped' && f.status !== 'error');
    if (active.length === 0) return 0;
    return active.reduce((sum, f) => sum + f.progress, 0) / active.length;
  }, [state.files]);

  const compatibleCount = state.files.filter(
    (f) =>
      state.settings.format &&
      f.status !== 'error' &&
      (f.mediaType === 'image' || f.mediaType === 'video' || f.mediaType === 'audio')
  ).length;

  const canConvert = !!state.settings.format && compatibleCount > 0 && state.view === 'ready';

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scroll,
        { paddingBottom: insets.bottom + spacing.giant },
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {state.view === 'idle' ? (
        <View style={styles.idle}>
          <Dropzone
            mode="convert"
            onPickFiles={handlePickFiles}
            onPickFromGallery={handlePickFromGallery}
          />
        </View>
      ) : null}

      {state.view === 'ready' ? (
        <View style={styles.stack}>
          {isBatch ? (
            <FileList
              files={state.files}
              view="ready"
              onRemoveFile={convert.removeFile}
              onAddFiles={handlePickFiles}
            />
          ) : single ? (
            <FilePreview file={single} />
          ) : null}

          <FormatPicker
            sourceTypes={sourceTypes}
            selectedFormat={state.settings.format}
            onSelect={(key) => convert.updateSettings({ format: key })}
          />

          <OutputSettings
            singleFileName={!isBatch ? single?.name?.replace(/\.[^.]+$/, '') ?? '' : undefined}
            formatExt={state.settings.format ?? undefined}
            quality={state.settings.quality}
            onQualityChange={(q) => convert.updateSettings({ quality: q })}
            qualityKind="image"
          />

          <View style={styles.actions}>
            <Pressable
              onPress={() => convert.reset()}
              style={({ pressed }) => [
                styles.ghostBtn,
                {
                  borderColor: theme.border.subtle,
                  backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                },
              ]}
            >
              <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>
                Back
              </Text>
            </Pressable>
            <Pressable
              onPress={handleStartConvert}
              disabled={!canConvert}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: theme.accent.primary,
                  opacity: !canConvert ? 0.3 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                {isBatch
                  ? `Convert ${compatibleCount} file${compatibleCount !== 1 ? 's' : ''}`
                  : `Convert${state.settings.format ? ` to ${state.settings.format.toUpperCase()}` : ''}`}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {state.view === 'converting' ? (
        <View style={styles.stack}>
          <FileList files={state.files} view="converting" />
          <ProgressBar progress={overallProgress} label="Converting…" />
          <View style={styles.actions}>
            <Pressable
              onPress={handleCancel}
              style={({ pressed }) => [
                styles.ghostBtn,
                {
                  borderColor: theme.border.subtle,
                  backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                },
              ]}
            >
              <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {state.view === 'done' ? (
        <OutputPanel
          files={state.files}
          actionLabel="converted"
          onStartOver={() => convert.reset()}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: spacing.huge,
    paddingTop: spacing.md,
    gap: spacing.xl,
    flexGrow: 1,
  },
  idle: { flexGrow: 1, justifyContent: 'center' },
  stack: { gap: spacing.xl },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingTop: spacing.sm,
    flexWrap: 'wrap',
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.giant,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghostBtnText: { ...typography.body, fontWeight: '600' },
});
