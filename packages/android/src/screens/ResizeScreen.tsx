import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Dropzone,
  FileList,
  FilePreview,
  OutputPanel,
  OutputSettings,
  ProgressBar,
} from '../components/convert';
import { CropControl, CropEditor, ResizeSettings } from '../components/resize';
import { MediaType, mediaTypeFromName } from '../lib/formats';
import { imageSize } from '../lib/image';
import { cancelResizeSession, runResizeSession } from '../lib/resizeQueue';
import { useResize } from '../state';
import { CropSpec, FileEntry } from '../state/types';
import { radius, spacing, typography, useTheme } from '../theme';

/**
 * Resize mode — Phase 5.
 *
 * Image-only today via expo-image-manipulator. Phase 4 adds FFmpeg-backed
 * video resize, which Phase 5b will wire in here (the same UI, just an
 * additional code path in resizeQueue.ts).
 */
export function ResizeScreen() {
  const { theme } = useTheme();
  const resize = useResize();
  const insets = useSafeAreaInsets();
  const { state } = resize;

  // Source image being cropped — drives the full-screen <CropEditor> modal.
  const [cropTarget, setCropTarget] = useState<{
    uri: string;
    width: number;
    height: number;
  } | null>(null);

  const handlePickFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*'],
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
      resize.addFiles(entries);
    } catch (e) {
      Alert.alert('Pick failed', e instanceof Error ? e.message : String(e));
    }
  }, [resize]);

  const handlePickFromGallery = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Grant access to your photos to pick from gallery.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 1,
      exif: false,
    });
    if (result.canceled || !result.assets?.length) return;
    const entries: FileEntry[] = result.assets.map((a, i) => ({
      id: `${Date.now()}-${i}-${a.fileName ?? 'image'}`,
      uri: a.uri,
      name: a.fileName ?? `image-${i}.jpg`,
      bytes: a.fileSize ?? 0,
      mediaType: 'image' as MediaType,
      width: a.width,
      height: a.height,
      status: 'ready',
      progress: 0,
    }));
    resize.addFiles(entries);
  }, [resize]);

  const handleOpenCrop = useCallback(async () => {
    const img = state.files.find((f) => f.mediaType === 'image');
    if (!img) return;
    try {
      // Probe via imageSize() (the same manipulateAsync path convertImage uses)
      // rather than trusting the picker's reported width/height — so the dims
      // the user frames against are exactly the ones the crop is applied to.
      // Avoids an EXIF-orientation mismatch on gallery photos where the picker's
      // dims can differ from the manipulator's view of the pixel buffer.
      const dims = await imageSize(img.uri);
      setCropTarget({ uri: img.uri, width: dims.width, height: dims.height });
    } catch (e) {
      Alert.alert('Could not open crop', e instanceof Error ? e.message : String(e));
    }
  }, [state.files]);

  const handleApplyCrop = useCallback(
    (crop: CropSpec) => {
      resize.updateSettings({ crop });
      setCropTarget(null);
    },
    [resize]
  );

  const handleClearCrop = useCallback(() => resize.updateSettings({ crop: null }), [resize]);

  // The original gate: a resize is configured.
  const hasResizeSetting =
    state.settings.mode === 'percentage'
      ? (state.settings.percent ?? 0) > 0
      : Boolean(state.settings.width || state.settings.height);
  // Will the export actually change pixel dimensions? (percent 100 = re-encode only)
  const willResize =
    state.settings.mode === 'percentage'
      ? (state.settings.percent ?? 0) > 0 && state.settings.percent !== 100
      : Boolean(state.settings.width || state.settings.height);
  const hasCrop = state.settings.crop != null;
  // A crop is a valid operation on its own — cropping alone is enough to export.
  const canResize =
    state.files.some((f) => f.mediaType === 'image' && f.status === 'ready') &&
    (hasResizeSetting || hasCrop);

  const handleStart = useCallback(() => {
    if (!canResize) return;
    const sessionId = resize.beginSession();
    runResizeSession({
      sessionId,
      files: state.files,
      settings: state.settings,
      onFileStart: (id) =>
        resize.dispatch({ type: 'fileStatus', sessionId, id, status: 'converting', progress: 0 }),
      onFileProgress: (id, progress) =>
        resize.dispatch({ type: 'fileProgress', sessionId, id, progress }),
      onFileDone: (id, outputUri, outputName, outputBytes) =>
        resize.dispatch({ type: 'fileResult', sessionId, id, outputUri, outputName, outputBytes }),
      onFileError: (id, error) =>
        resize.dispatch({ type: 'fileError', sessionId, id, error }),
      onFileSkipped: (id) =>
        resize.dispatch({ type: 'fileStatus', sessionId, id, status: 'skipped' }),
    }).finally(() => resize.dispatch({ type: 'finishSession', sessionId }));
  }, [canResize, resize, state.files, state.settings]);

  const handleCancel = useCallback(() => {
    if (state.currentSessionId) cancelResizeSession(state.currentSessionId);
    resize.cancel();
  }, [resize, state.currentSessionId]);

  const isBatch = state.files.length > 1;
  const single = state.files[0];
  const overallProgress = useMemo(() => {
    const active = state.files.filter((f) => f.status !== 'skipped' && f.status !== 'error');
    if (active.length === 0) return 0;
    return active.reduce((sum, f) => sum + f.progress, 0) / active.length;
  }, [state.files]);
  const imageCount = state.files.filter((f) => f.mediaType === 'image' && f.status === 'ready').length;

  return (
    <>
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
            mode="resize"
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
              onRemoveFile={resize.removeFile}
              onAddFiles={handlePickFiles}
            />
          ) : single ? (
            <>
              <FilePreview file={single} />
              {single.mediaType === 'image' ? (
                <CropControl
                  crop={state.settings.crop}
                  onEdit={handleOpenCrop}
                  onClear={handleClearCrop}
                />
              ) : null}
            </>
          ) : null}

          <ResizeSettings
            files={state.files}
            settings={state.settings}
            onUpdate={(patch) => resize.updateSettings(patch)}
          />

          <OutputSettings
            quality={state.settings.quality}
            onQualityChange={(q) => resize.updateSettings({ quality: q })}
            qualityKind="image"
          />

          <View style={styles.actions}>
            <Pressable
              onPress={() => resize.reset()}
              style={({ pressed }) => [
                styles.ghostBtn,
                {
                  borderColor: theme.border.subtle,
                  backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                },
              ]}
            >
              <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>Back</Text>
            </Pressable>
            <Pressable
              onPress={handleStart}
              disabled={!canResize}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: theme.accent.primary,
                  opacity: !canResize ? 0.3 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: theme.accent.onPrimary }]}>
                {isBatch
                  ? `Resize ${imageCount} image${imageCount !== 1 ? 's' : ''}`
                  : willResize
                  ? 'Resize'
                  : hasCrop
                  ? 'Crop & save'
                  : 'Save'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {state.view === 'converting' ? (
        <View style={styles.stack}>
          <FileList files={state.files} view="converting" />
          <ProgressBar progress={overallProgress} label="Resizing…" />
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
              <Text style={[styles.ghostBtnText, { color: theme.text.secondary }]}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {state.view === 'done' ? (
        <OutputPanel
          files={state.files}
          actionLabel="resized"
          onStartOver={() => resize.reset()}
        />
      ) : null}
    </ScrollView>

    {cropTarget ? (
      <CropEditor
        uri={cropTarget.uri}
        imageWidth={cropTarget.width}
        imageHeight={cropTarget.height}
        initialCrop={state.settings.crop}
        onCancel={() => setCropTarget(null)}
        onApply={handleApplyCrop}
      />
    ) : null}
    </>
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
});
