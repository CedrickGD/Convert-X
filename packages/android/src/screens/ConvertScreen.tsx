import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { ImagePlus, RotateCcw, Share2, X } from 'lucide-react-native';
import React, { useCallback } from 'react';
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

import { mediaTypeFromName, prettyBytes } from '../lib/formats';
import { saveToGallery, supportedImageFormats } from '../lib/image';
import { runConvertSession, cancelSession } from '../lib/conversionQueue';
import { useConvert } from '../state';
import { FileEntry } from '../state/types';
import { radius, spacing, typography, useTheme } from '../theme';

/**
 * Convert mode — Phase 2 wiring.
 *
 * Functional but minimal. Phase 3 ports the desktop Dropzone / FileList /
 * FilePreview / FormatPicker / OutputSettings components and replaces the
 * inline UI here with those.
 *
 * What's working today (image-only via expo-image-manipulator):
 *  - Pick an image (DocumentPicker or ImagePicker)
 *  - Pick a target format (PNG / JPG / WebP)
 *  - Adjust quality
 *  - Start conversion (kicks the module-level queue)
 *  - Cancel mid-flight
 *  - Share / save the result
 */
export function ConvertScreen() {
  const { theme } = useTheme();
  const convert = useConvert();
  const insets = useSafeAreaInsets();
  const { state } = convert;

  const handlePick = useCallback(async () => {
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
      mediaType: 'image',
      width: a.width,
      height: a.height,
      status: 'ready',
      progress: 0,
    }));
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
    // Fire and forget — queue lives at module scope so this survives unmount.
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

  const handleShare = useCallback(async (uri: string) => {
    const can = await Sharing.isAvailableAsync();
    if (!can) {
      Alert.alert('Share unavailable', 'Sharing is not supported on this device.');
      return;
    }
    await Sharing.shareAsync(uri).catch(() => {});
  }, []);

  const handleSave = useCallback(async (uri: string) => {
    const ok = await saveToGallery(uri);
    Alert.alert(ok ? 'Saved' : 'Save failed', ok ? 'Image saved to Convert-X album.' : 'Permission denied.');
  }, []);

  const fmts = supportedImageFormats();
  const file = state.files[0]; // single-file MVP for Phase 2 — Phase 3 adds batch UI

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scroll,
        { paddingBottom: insets.bottom + spacing.giant },
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {state.files.length === 0 ? (
        <View style={styles.idleWrap}>
          <View
            style={[
              styles.dropzone,
              { borderColor: theme.border.hover, backgroundColor: theme.bg.secondary },
            ]}
          >
            <View
              style={[
                styles.dropzoneIcon,
                { backgroundColor: theme.accent.subtle },
              ]}
            >
              <ImagePlus size={24} strokeWidth={1.8} color={theme.accent.primary} />
            </View>
            <Text style={[styles.dropzoneTitle, { color: theme.text.primary }]}>
              Pick an image to convert
            </Text>
            <Text style={[styles.dropzoneSub, { color: theme.text.secondary }]}>
              PNG · JPG · WebP today. Video / audio coming with FFmpeg in Phase 4.
            </Text>
            <View style={styles.pickRow}>
              <Pressable
                onPress={handlePick}
                style={({ pressed }) => [
                  styles.ghostBtn,
                  {
                    borderColor: theme.border.subtle,
                    backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                  },
                ]}
              >
                <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>
                  From files
                </Text>
              </Pressable>
              <Pressable
                onPress={handlePickFromGallery}
                style={({ pressed }) => [
                  styles.ghostBtn,
                  {
                    borderColor: theme.border.subtle,
                    backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                  },
                ]}
              >
                <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>
                  From gallery
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.readyWrap}>
          {/* File row */}
          <View
            style={[
              styles.fileCard,
              { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
            ]}
          >
            <View style={styles.fileRow}>
              <View style={[styles.dot, { backgroundColor: theme.accent.primary }]} />
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={[styles.fileName, { color: theme.text.primary }]}
                >
                  {file?.outputName ?? file?.name}
                </Text>
                <Text style={[styles.fileMeta, { color: theme.text.muted }]}>
                  {file?.status === 'done'
                    ? `${prettyBytes(file?.outputBytes ?? 0)} · saved`
                    : file?.status === 'error'
                    ? file?.error
                    : `${prettyBytes(file?.bytes ?? 0)} · ${file?.mediaType}`}
                </Text>
                {file?.status === 'converting' ? (
                  <View
                    style={[styles.progressTrack, { backgroundColor: theme.bg.surfaceSunken }]}
                  >
                    <View
                      style={[
                        styles.progressFill,
                        {
                          backgroundColor: theme.accent.primary,
                          width: `${file?.progress ?? 0}%`,
                        },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
              {state.view === 'ready' ? (
                <Pressable
                  onPress={() => file && convert.removeFile(file.id)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.removeBtn, { opacity: pressed ? 0.5 : 1 }]}
                >
                  <X size={16} strokeWidth={2} color={theme.text.muted} />
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* Format picker */}
          {state.view === 'ready' ? (
            <View
              style={[
                styles.card,
                { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
              ]}
            >
              <Text style={[styles.label, { color: theme.text.muted }]}>Format</Text>
              <View style={styles.chipRow}>
                {fmts.map((f) => {
                  const selected = state.settings.format === f.key;
                  return (
                    <Pressable
                      key={f.key}
                      onPress={() => convert.updateSettings({ format: f.key })}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: selected ? theme.accent.primary : theme.bg.secondary,
                          borderColor: selected ? theme.accent.primary : theme.border.subtle,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipLabel,
                          { color: selected ? theme.accent.onPrimary : theme.text.secondary },
                        ]}
                      >
                        {f.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={{ marginTop: spacing.xl }}>
                <Text style={[styles.label, { color: theme.text.muted }]}>
                  Quality · {state.settings.quality}%
                </Text>
                <View style={[styles.qualityRow]}>
                  <TextInput
                    keyboardType="number-pad"
                    value={String(state.settings.quality)}
                    onChangeText={(v) => {
                      const n = parseInt(v, 10);
                      if (!Number.isNaN(n)) convert.updateSettings({ quality: Math.max(1, Math.min(100, n)) });
                    }}
                    style={[
                      styles.input,
                      {
                        color: theme.text.primary,
                        backgroundColor: theme.bg.surfaceSunken,
                        borderColor: theme.border.subtle,
                      },
                    ]}
                  />
                </View>
              </View>
            </View>
          ) : null}

          {/* Actions */}
          <View style={styles.actionsRow}>
            {state.view === 'ready' ? (
              <>
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
                  <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>Back</Text>
                </Pressable>
                <Pressable
                  onPress={handleStartConvert}
                  disabled={!state.settings.format}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    {
                      backgroundColor: theme.accent.primary,
                      opacity: !state.settings.format ? 0.3 : pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.primaryBtnLabel, { color: theme.accent.onPrimary }]}>
                    Convert{state.settings.format ? ` to ${state.settings.format.toUpperCase()}` : ''}
                  </Text>
                </Pressable>
              </>
            ) : state.view === 'converting' ? (
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
                <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>Cancel</Text>
              </Pressable>
            ) : (
              <>
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
                  <RotateCcw size={14} strokeWidth={2} color={theme.text.secondary} />
                  <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>
                    Convert another
                  </Text>
                </Pressable>
                {file?.outputUri ? (
                  <>
                    <Pressable
                      onPress={() => file.outputUri && handleSave(file.outputUri)}
                      style={({ pressed }) => [
                        styles.ghostBtn,
                        {
                          borderColor: theme.border.subtle,
                          backgroundColor: pressed ? theme.bg.surfaceHigh : 'transparent',
                        },
                      ]}
                    >
                      <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>
                        Save
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => file.outputUri && handleShare(file.outputUri)}
                      style={({ pressed }) => [
                        styles.primaryBtn,
                        {
                          backgroundColor: theme.accent.primary,
                          opacity: pressed ? 0.85 : 1,
                        },
                      ]}
                    >
                      <Share2 size={14} strokeWidth={2} color={theme.accent.onPrimary} />
                      <Text style={[styles.primaryBtnLabel, { color: theme.accent.onPrimary }]}>
                        Share
                      </Text>
                    </Pressable>
                  </>
                ) : null}
              </>
            )}
          </View>
        </View>
      )}
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

  idleWrap: { flexGrow: 1, justifyContent: 'center' },
  dropzone: {
    paddingVertical: 56,
    paddingHorizontal: spacing.huge,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    gap: spacing.lg,
  },
  dropzoneIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropzoneTitle: { ...typography.bodyLg, textAlign: 'center' },
  dropzoneSub: { ...typography.caption, textAlign: 'center', paddingHorizontal: spacing.lg },
  pickRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },

  readyWrap: { gap: spacing.xl },

  fileCard: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dot: { width: 8, height: 8, borderRadius: 4 },
  fileName: { ...typography.base, color: undefined },
  fileMeta: { ...typography.micro, marginTop: 2 },
  progressTrack: { height: 3, borderRadius: 2, marginTop: spacing.sm, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  removeBtn: { padding: 4 },

  card: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  label: { ...typography.micro, textTransform: 'uppercase', letterSpacing: 0.6 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.pico, marginTop: spacing.sm },
  chip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: { ...typography.caption },

  qualityRow: { marginTop: spacing.sm },
  input: {
    ...typography.bodySm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xs,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },

  actionsRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    justifyContent: 'center',
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
  primaryBtnLabel: { ...typography.body, fontWeight: '600' },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.giant,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghostBtnLabel: { ...typography.body, fontWeight: '600' },
});
