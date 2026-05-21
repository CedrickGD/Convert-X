import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ImageIcon,
  Lock,
  Loader2,
  Maximize2,
  Music,
  RefreshCw,
  SlidersHorizontal,
  SwatchBook,
  Video,
  Wand2,
} from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  Layout,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { FilePickTile } from '../components/FilePickTile';
import { FileRow } from '../components/FileRow';
import { FormatChip } from '../components/FormatChip';
import { GlassCard } from '../components/GlassCard';
import { GradientButton } from '../components/GradientButton';
import { Header } from '../components/Header';
import { OutputRow } from '../components/OutputRow';
import { PressableScale } from '../components/PressableScale';
import { SectionLabel } from '../components/SectionLabel';
import { SegmentedControl } from '../components/SegmentedControl';
import { Slider } from '../components/Slider';
import { FormatDef, formatsByCategory, MediaType, mediaTypeFromName } from '../lib/formats';
import { haptics } from '../lib/haptics';
import { addHistory } from '../lib/history';
import { convertImage, ConvertResult, isSupportedImageFormat, ResizeSpec } from '../lib/image';
import { motion, radius, spacing, typography, useTheme } from '../theme';

type PickedFile = {
  uri: string;
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  mediaType: MediaType;
};

type Preset = 'resize' | 'compress' | 'convert';
type ResizeMode = 'original' | 'percentage' | 'pixels';

const DEFAULTS_BY_PRESET: Record<
  Preset,
  { quality: number; resizeMode: ResizeMode; resizePercent: number }
> = {
  resize: { quality: 92, resizeMode: 'percentage', resizePercent: 50 },
  compress: { quality: 60, resizeMode: 'original', resizePercent: 100 },
  convert: { quality: 90, resizeMode: 'original', resizePercent: 100 },
};

export function HomeScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  // ── Picker state ─────────────────────────────────────────────────────────
  const [file, setFile] = useState<PickedFile | null>(null);
  const [preset, setPreset] = useState<Preset>('convert');

  // ── Conversion params ────────────────────────────────────────────────────
  const [format, setFormat] = useState<FormatDef | null>(null);
  const [quality, setQuality] = useState<number>(DEFAULTS_BY_PRESET.convert.quality);
  const [resizeMode, setResizeMode] = useState<ResizeMode>(DEFAULTS_BY_PRESET.convert.resizeMode);
  const [resizePercent, setResizePercent] = useState<number>(
    DEFAULTS_BY_PRESET.convert.resizePercent
  );
  const [pixelWidth, setPixelWidth] = useState<string>('');
  const [pixelHeight, setPixelHeight] = useState<string>('');
  const [lockAspect, setLockAspect] = useState<boolean>(true);

  // ── Flow state ──────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<ConvertResult | null>(null);

  // Apply preset defaults whenever the preset changes (only before conversion).
  useEffect(() => {
    const d = DEFAULTS_BY_PRESET[preset];
    setQuality(d.quality);
    setResizeMode(d.resizeMode);
    setResizePercent(d.resizePercent);
  }, [preset]);

  const handlePick = useCallback(async () => {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!req.granted) {
        haptics.warn();
        Alert.alert(
          'Permission needed',
          'Convert-X needs access to your photos to pick an image.'
        );
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
      exif: false,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const name = asset.fileName ?? `image-${Date.now()}.${inferExt(asset.uri)}`;
    const next: PickedFile = {
      uri: asset.uri,
      name,
      bytes: asset.fileSize ?? 0,
      width: asset.width,
      height: asset.height,
      mediaType: mediaTypeFromName(name) === 'unknown' ? 'image' : mediaTypeFromName(name),
    };
    setFile(next);
    setOutput(null);
    setFormat(null);
    setPixelWidth(String(asset.width ?? ''));
    setPixelHeight(String(asset.height ?? ''));
    haptics.success();
  }, []);

  const handleReset = useCallback(() => {
    setFile(null);
    setFormat(null);
    setOutput(null);
    setPixelWidth('');
    setPixelHeight('');
    setPreset('convert');
  }, []);

  const handleConvert = useCallback(async () => {
    if (!file || !format) return;
    if (!isSupportedImageFormat(format)) {
      Alert.alert(format.label, 'That format is coming in a future update.');
      haptics.warn();
      return;
    }

    let resize: ResizeSpec = { kind: 'none' };
    if (resizeMode === 'percentage') {
      resize = { kind: 'percentage', percent: resizePercent };
    } else if (resizeMode === 'pixels') {
      const w = Number(pixelWidth) || undefined;
      const h = Number(pixelHeight) || undefined;
      if (w || h) {
        resize = { kind: 'pixels', width: w, height: h };
      }
    }

    try {
      setBusy(true);
      haptics.press();
      const result = await convertImage({
        sourceUri: file.uri,
        sourceName: file.name,
        targetFormat: format,
        quality,
        resize,
      });
      await addHistory({
        id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        timestamp: Date.now(),
        sourceName: file.name,
        outputName: result.outputName,
        outputUri: result.outputUri,
        bytes: result.bytes,
        formatKey: format.key,
      });
      setOutput(result);
      haptics.success();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Conversion failed.';
      Alert.alert('Conversion failed', message);
      haptics.error();
    } finally {
      setBusy(false);
    }
  }, [file, format, quality, resizeMode, resizePercent, pixelWidth, pixelHeight]);

  const aspect = useMemo(() => {
    if (!file?.width || !file?.height) return 1;
    return file.width / file.height;
  }, [file?.width, file?.height]);

  const categories = useMemo(
    () => (file ? formatsByCategory(file.mediaType) : null),
    [file]
  );

  const canConvert =
    !!file && !!format && isSupportedImageFormat(format) && !busy && !output;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg.base }]}>
      <Header title="Convert" subtitle="Transform images locally on device" />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: insets.bottom + spacing.huge + spacing.xl },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {!file ? (
            <EmptyPickerBody preset={preset} setPreset={setPreset} onPick={handlePick} />
          ) : output ? (
            <DoneBody output={output} onReset={handleReset} />
          ) : (
            <ConfigBody
              file={file}
              onRemove={handleReset}
              categories={categories}
              format={format}
              onPickFormat={setFormat}
              quality={quality}
              onQuality={setQuality}
              resizeMode={resizeMode}
              onResizeMode={setResizeMode}
              resizePercent={resizePercent}
              onResizePercent={setResizePercent}
              pixelWidth={pixelWidth}
              pixelHeight={pixelHeight}
              onPixelWidth={(v) => {
                setPixelWidth(v);
                if (lockAspect && aspect && Number(v)) {
                  const h = Math.round(Number(v) / aspect);
                  setPixelHeight(String(h));
                }
              }}
              onPixelHeight={(v) => {
                setPixelHeight(v);
                if (lockAspect && aspect && Number(v)) {
                  const w = Math.round(Number(v) * aspect);
                  setPixelWidth(String(w));
                }
              }}
              lockAspect={lockAspect}
              onLockAspect={setLockAspect}
            />
          )}
        </ScrollView>

        {/* Sticky CTA when a file is picked (and no output yet) */}
        {file && !output ? (
          <Animated.View
            entering={FadeIn.springify().damping(16)}
            exiting={FadeOut}
            style={[
              styles.stickyCta,
              {
                paddingBottom: insets.bottom + spacing.lg,
                backgroundColor: 'transparent',
              },
            ]}
          >
            <LinearGradient
              colors={
                [
                  `${theme.bg.base}00`,
                  theme.bg.base,
                ] as unknown as readonly [string, string]
              }
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 0.35 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <GradientButton
              onPress={handleConvert}
              disabled={!canConvert}
              leading={
                <Wand2
                  size={18}
                  strokeWidth={1.9}
                  color={canConvert ? theme.text.onAccent : theme.text.tertiary}
                />
              }
            >
              {busy ? 'Converting…' : 'Convert'}
            </GradientButton>
          </Animated.View>
        ) : null}
      </KeyboardAvoidingView>

      {busy ? <ConvertingOverlay fileName={file?.name ?? ''} /> : null}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-bodies
// ────────────────────────────────────────────────────────────────────────────

function EmptyPickerBody({
  preset,
  setPreset,
  onPick,
}: {
  preset: Preset;
  setPreset: (p: Preset) => void;
  onPick: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Animated.View entering={FadeIn.springify().damping(14)} layout={Layout.springify()}>
      <View style={styles.halo} pointerEvents="none">
        <LinearGradient
          colors={
            [
              theme.accent.primarySoft,
              `${theme.accent.primarySoft}00`,
            ] as unknown as readonly [string, string]
          }
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </View>

      <FilePickTile onPress={onPick} />

      <View style={styles.presetWrap}>
        <SectionLabel>Start with a preset</SectionLabel>
        <SegmentedControl<Preset>
          value={preset}
          onChange={setPreset}
          segments={[
            {
              key: 'resize',
              label: 'Resize',
              icon: (
                <Maximize2
                  size={16}
                  strokeWidth={1.8}
                  color={preset === 'resize' ? theme.text.onAccent : theme.text.secondary}
                />
              ),
            },
            {
              key: 'compress',
              label: 'Compress',
              icon: (
                <SlidersHorizontal
                  size={16}
                  strokeWidth={1.8}
                  color={preset === 'compress' ? theme.text.onAccent : theme.text.secondary}
                />
              ),
            },
            {
              key: 'convert',
              label: 'Convert',
              icon: (
                <SwatchBook
                  size={16}
                  strokeWidth={1.8}
                  color={preset === 'convert' ? theme.text.onAccent : theme.text.secondary}
                />
              ),
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

type ConfigProps = {
  file: PickedFile;
  onRemove: () => void;
  categories: ReturnType<typeof formatsByCategory> | null;
  format: FormatDef | null;
  onPickFormat: (f: FormatDef) => void;
  quality: number;
  onQuality: (q: number) => void;
  resizeMode: ResizeMode;
  onResizeMode: (m: ResizeMode) => void;
  resizePercent: number;
  onResizePercent: (p: number) => void;
  pixelWidth: string;
  pixelHeight: string;
  onPixelWidth: (v: string) => void;
  onPixelHeight: (v: string) => void;
  lockAspect: boolean;
  onLockAspect: (v: boolean) => void;
};

function ConfigBody(props: ConfigProps) {
  const { theme } = useTheme();
  const {
    file,
    onRemove,
    categories,
    format,
    onPickFormat,
    quality,
    onQuality,
    resizeMode,
    onResizeMode,
    resizePercent,
    onResizePercent,
    pixelWidth,
    pixelHeight,
    onPixelWidth,
    onPixelHeight,
    lockAspect,
    onLockAspect,
  } = props;

  return (
    <Animated.View
      entering={FadeIn.springify().damping(14)}
      layout={Layout.springify()}
      style={styles.column}
    >
      <FileRow
        uri={file.uri}
        name={file.name}
        bytes={file.bytes}
        width={file.width}
        height={file.height}
        onRemove={onRemove}
      />

      {/* Format section */}
      <View style={styles.section}>
        <SectionLabel>Target format</SectionLabel>
        {categories ? (
          <View style={styles.formatGroups}>
            <FormatGroup
              title="Image"
              icon={<ImageIcon size={14} strokeWidth={1.8} color={theme.text.tertiary} />}
              formats={categories.image}
              selected={format}
              onPick={onPickFormat}
            />
            {categories.video.length > 0 ? (
              <FormatGroup
                title="Video"
                icon={<Video size={14} strokeWidth={1.8} color={theme.text.tertiary} />}
                formats={categories.video}
                selected={format}
                onPick={onPickFormat}
              />
            ) : null}
            {categories.audio.length > 0 ? (
              <FormatGroup
                title="Audio"
                icon={<Music size={14} strokeWidth={1.8} color={theme.text.tertiary} />}
                formats={categories.audio}
                selected={format}
                onPick={onPickFormat}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Quality */}
      <View style={styles.section}>
        <SectionLabel>Quality</SectionLabel>
        <GlassCard>
          <Slider
            label="Compression"
            suffix="%"
            min={10}
            max={100}
            value={quality}
            onChange={onQuality}
          />
          <Text style={[styles.hint, { color: theme.text.tertiary, marginTop: spacing.sm }]}>
            Higher values keep more detail and produce larger files.
          </Text>
        </GlassCard>
      </View>

      {/* Resize */}
      <View style={styles.section}>
        <SectionLabel>Resize</SectionLabel>
        <GlassCard>
          <SegmentedControl<ResizeMode>
            value={resizeMode}
            onChange={onResizeMode}
            segments={[
              { key: 'original', label: 'Original' },
              { key: 'percentage', label: 'Percentage' },
              { key: 'pixels', label: 'Pixels' },
            ]}
          />
          {resizeMode === 'percentage' ? (
            <View style={styles.resizeBody}>
              <Slider
                label="Scale"
                suffix="%"
                min={10}
                max={200}
                value={resizePercent}
                onChange={onResizePercent}
              />
            </View>
          ) : null}
          {resizeMode === 'pixels' ? (
            <View style={styles.resizeBody}>
              <View style={styles.pixelRow}>
                <PixelInput
                  label="Width"
                  value={pixelWidth}
                  onChangeText={onPixelWidth}
                />
                <PixelInput
                  label="Height"
                  value={pixelHeight}
                  onChangeText={onPixelHeight}
                />
              </View>
              <AspectLockToggle value={lockAspect} onChange={onLockAspect} />
            </View>
          ) : null}
          {resizeMode === 'original' ? (
            <Text style={[styles.hint, { color: theme.text.tertiary, marginTop: spacing.md }]}>
              Keeps the original dimensions.
            </Text>
          ) : null}
        </GlassCard>
      </View>

      {/* Unsupported format warning */}
      {format && !isSupportedImageFormat(format) ? (
        <Animated.View entering={FadeIn.springify()} layout={Layout.springify()}>
          <GlassCard style={styles.warnCard}>
            <View style={styles.warnRow}>
              <Lock size={18} strokeWidth={1.8} color={theme.status.warning} />
              <Text style={[styles.warnText, { color: theme.text.secondary }]}>
                {format.label} conversions aren't available yet on mobile. Pick another format
                or use the desktop app.
              </Text>
            </View>
          </GlassCard>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function FormatGroup({
  title,
  icon,
  formats,
  selected,
  onPick,
}: {
  title: string;
  icon: React.ReactNode;
  formats: FormatDef[];
  selected: FormatDef | null;
  onPick: (f: FormatDef) => void;
}) {
  const { theme } = useTheme();
  if (!formats.length) return null;
  return (
    <View style={styles.formatGroup}>
      <View style={styles.formatGroupHeader}>
        {icon}
        <Text style={[styles.formatGroupTitle, { color: theme.text.tertiary }]}>{title}</Text>
      </View>
      <View style={styles.chips}>
        {formats.map((f) => (
          <FormatChip
            key={f.key}
            format={f}
            selected={selected?.key === f.key}
            onPress={onPick}
          />
        ))}
      </View>
    </View>
  );
}

function PixelInput({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
}) {
  const { theme } = useTheme();
  return (
    <View style={styles.pixelInputWrap}>
      <Text style={[styles.pixelLabel, { color: theme.text.tertiary }]}>{label}</Text>
      <View
        style={[
          styles.pixelField,
          {
            backgroundColor: theme.bg.surfaceSunken,
            borderColor: theme.border.subtle,
          },
        ]}
      >
        <TextInput
          style={[styles.pixelInput, { color: theme.text.primary }]}
          value={value}
          onChangeText={(text) => onChangeText(text.replace(/[^0-9]/g, ''))}
          keyboardType="number-pad"
          placeholder="auto"
          placeholderTextColor={theme.text.tertiary}
          selectionColor={theme.accent.primary}
        />
        <Text style={[styles.pixelSuffix, { color: theme.text.tertiary }]}>px</Text>
      </View>
    </View>
  );
}

function AspectLockToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const { theme } = useTheme();
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(value ? 1 : 0, motion.spring.snappy);
  }, [value, progress]);

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * 20 }],
  }));
  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: progress.value > 0.5 ? theme.accent.primary : theme.bg.surfaceSunken,
  }));

  return (
    <PressableScale
      onPress={() => onChange(!value)}
      hapticType="pick"
      pressedScale={0.97}
      style={styles.aspectRow}
    >
      <View style={styles.aspectLabel}>
        <Text style={[styles.pixelLabel, { color: theme.text.secondary }]}>
          Lock aspect ratio
        </Text>
        <Text style={[styles.hint, { color: theme.text.tertiary }]}>
          Match the original proportions.
        </Text>
      </View>
      <Animated.View
        style={[
          styles.switchTrack,
          {
            borderColor: theme.border.subtle,
          },
          trackStyle,
        ]}
      >
        <Animated.View
          style={[styles.switchThumb, { backgroundColor: '#fff' }, thumbStyle]}
        />
      </Animated.View>
    </PressableScale>
  );
}

function DoneBody({
  output,
  onReset,
}: {
  output: ConvertResult;
  onReset: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Animated.View
      entering={FadeIn.springify().damping(14)}
      layout={Layout.springify()}
      style={styles.column}
    >
      <View style={styles.doneHeader}>
        <Text style={[typography.label, { color: theme.accent.primary }]}>
          Conversion complete
        </Text>
        <Text style={[typography.title, { color: theme.text.primary }]}>Looks good.</Text>
        <Text style={[typography.caption, { color: theme.text.tertiary }]}>
          Share it, save it to your gallery, or copy the on-device path.
        </Text>
      </View>
      <OutputRow uri={output.outputUri} name={output.outputName} bytes={output.bytes} />
      <PressableScale
        onPress={onReset}
        hapticType="tap"
        style={[
          styles.secondaryBtn,
          {
            borderColor: theme.border.strong,
          },
        ]}
      >
        <RefreshCw size={18} strokeWidth={1.8} color={theme.text.primary} />
        <Text style={[typography.bodyEmph, { color: theme.text.primary }]}>
          Convert another
        </Text>
      </PressableScale>
    </Animated.View>
  );
}

function ConvertingOverlay({ fileName }: { fileName: string }) {
  const { theme } = useTheme();
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1100, easing: Easing.linear }),
      -1,
      false
    );
    return () => cancelAnimation(rotation);
  }, [rotation]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      entering={FadeIn.duration(motion.timing.fast)}
      exiting={FadeOut}
      style={[styles.overlay, { backgroundColor: theme.overlay.scrim }]}
      pointerEvents="auto"
    >
      <GlassCard glowing style={styles.overlayCard}>
        <View style={styles.overlayInner}>
          <View
            style={[
              styles.overlayIconRing,
              {
                backgroundColor: theme.bg.surfaceSunken,
                borderColor: theme.accent.primary,
              },
            ]}
          >
            <Animated.View style={iconStyle}>
              <Loader2 size={28} strokeWidth={1.8} color={theme.accent.primary} />
            </Animated.View>
          </View>
          <Text style={[typography.headline, { color: theme.text.primary }]}>
            Converting…
          </Text>
          <Text
            style={[typography.caption, { color: theme.text.tertiary, textAlign: 'center' }]}
            numberOfLines={1}
          >
            {fileName || 'Processing your file'}
          </Text>
        </View>
      </GlassCard>
    </Animated.View>
  );
}

// Small helpers
function inferExt(uri: string): string {
  const m = uri.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  return m ? m[1] : 'jpg';
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  column: {
    gap: spacing.lg,
  },
  section: {
    gap: spacing.sm,
  },
  halo: {
    position: 'absolute',
    top: -spacing.huge,
    left: -spacing.huge,
    right: -spacing.huge,
    height: 420,
    opacity: 0.35,
  },
  presetWrap: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  formatGroups: {
    gap: spacing.md,
  },
  formatGroup: {
    gap: spacing.sm,
  },
  formatGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  formatGroupTitle: {
    ...typography.micro,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.sm,
    columnGap: spacing.xs,
  },
  resizeBody: {
    marginTop: spacing.md,
    gap: spacing.md,
  },
  pixelRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  pixelInputWrap: {
    flex: 1,
    gap: spacing.xs,
  },
  pixelLabel: {
    ...typography.caption,
  },
  pixelField: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pixelInput: {
    flex: 1,
    ...typography.bodyEmph,
    padding: 0,
  },
  pixelSuffix: {
    ...typography.caption,
    marginLeft: spacing.xs,
  },
  aspectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  aspectLabel: {
    flex: 1,
    gap: spacing.xxs,
  },
  switchTrack: {
    width: 44,
    height: 24,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 2,
    justifyContent: 'center',
  },
  switchThumb: {
    width: 18,
    height: 18,
    borderRadius: radius.round,
  },
  hint: {
    ...typography.caption,
  },
  warnCard: {
    borderColor: 'transparent',
  },
  warnRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  warnText: {
    ...typography.caption,
    flex: 1,
  },
  stickyCta: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  doneHeader: {
    gap: spacing.xxs,
    marginBottom: spacing.xs,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  overlayCard: {
    width: '86%',
    maxWidth: 360,
  },
  overlayInner: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  overlayIconRing: {
    width: 72,
    height: 72,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.sm,
  },
});
