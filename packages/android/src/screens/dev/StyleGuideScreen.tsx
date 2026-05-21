import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ChevronLeft, Moon, Sun } from 'lucide-react-native';
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RootStackParamList } from '../../navigation/types';
import {
  DARK_THEME,
  fontFamily,
  LIGHT_THEME,
  radius,
  spacing,
  Theme,
  typography,
  useTheme,
} from '../../theme';

type Nav = NativeStackNavigationProp<RootStackParamList, 'StyleGuide'>;

/**
 * Visual reference for the Convert-X Android design system.
 *
 * Shown gated by __DEV__ — accessible via the temp button on HomeScreen.
 * Renders every color token, typography style, radius, and a strip of sample
 * components in the desktop Convert-X visual language so we can diff against
 * the desktop app screenshot side-by-side.
 */
export function StyleGuideScreen() {
  const { theme, settings, setColorScheme } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { backgroundColor: theme.bg.base }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.giant },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={12}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: theme.border.subtle, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <ChevronLeft size={16} strokeWidth={2} color={theme.text.secondary} />
          </Pressable>

          <Text style={[styles.wordmark, { color: theme.text.primary }]}>
            Convert-<Text style={{ color: theme.accent.primary }}>X</Text>{' '}
            <Text style={[styles.wordmarkSub, { color: theme.text.secondary }]}>
              · Style Guide
            </Text>
          </Text>

          <Pressable
            onPress={() => setColorScheme(theme.isDark ? 'light' : 'dark')}
            hitSlop={12}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: theme.border.subtle, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            {theme.isDark ? (
              <Sun size={16} strokeWidth={2} color={theme.text.secondary} />
            ) : (
              <Moon size={16} strokeWidth={2} color={theme.text.secondary} />
            )}
          </Pressable>
        </View>

        {/* Color tokens */}
        <Section title="Colors — current theme">
          <SwatchRow theme={theme} group="bg" />
          <SwatchRow theme={theme} group="accent" />
          <SwatchRow theme={theme} group="text" />
          <SwatchRow theme={theme} group="border" />
          <SwatchRow theme={theme} group="status" />
          <SwatchRow theme={theme} group="overlay" />
        </Section>

        {/* Both themes side-by-side */}
        <Section title="Dark vs Light snapshot">
          <View style={styles.themeCompareRow}>
            <ThemeCard label="Dark" t={DARK_THEME} />
            <ThemeCard label="Light" t={LIGHT_THEME} />
          </View>
        </Section>

        {/* Typography */}
        <Section title="Typography — Inter">
          <TypeRow theme={theme} styleKey="display" label="display · 20.8" />
          <TypeRow theme={theme} styleKey="hero" label="hero · 22.4" />
          <TypeRow theme={theme} styleKey="titleAlt" label="titleAlt · 18.4" />
          <TypeRow theme={theme} styleKey="title" label="title · 17.6" />
          <TypeRow theme={theme} styleKey="bodyLg" label="bodyLg · 16" />
          <TypeRow theme={theme} styleKey="bodyEmph" label="bodyEmph · 13.6 / 600" />
          <TypeRow theme={theme} styleKey="body" label="body · 13.6 / 500" />
          <TypeRow theme={theme} styleKey="bodySm" label="bodySm · 13.1" />
          <TypeRow theme={theme} styleKey="base" label="base · 12.5 / 600 (tabs)" />
          <TypeRow theme={theme} styleKey="caption" label="caption · 11.5" />
          <TypeRow theme={theme} styleKey="micro" label="micro · 10.9" />
          <TypeRow theme={theme} styleKey="tiny" label="tiny · 9.3" />
        </Section>

        {/* Radii */}
        <Section title="Radii — 14 / 10 / 6">
          <View style={styles.radiiRow}>
            <RadiusTile label="md (14)" value={radius.md} theme={theme} />
            <RadiusTile label="sm (10)" value={radius.sm} theme={theme} />
            <RadiusTile label="xs (6)" value={radius.xs} theme={theme} />
          </View>
        </Section>

        {/* Spacing */}
        <Section title="Spacing rhythm">
          <SpacingBars theme={theme} />
        </Section>

        {/* Sample components */}
        <Section title="Navbar (Convert / Resize / Download / Credits & App)">
          <NavbarPreview theme={theme} />
        </Section>

        <Section title="Buttons">
          <View style={styles.btnRow}>
            <PrimaryButton theme={theme} label="Convert to MP4" />
            <GhostButton theme={theme} label="Back" />
          </View>
          <View style={[styles.btnRow, { marginTop: spacing.md }]}>
            <PrimaryButton theme={theme} label="Convert to MP4" disabled />
            <GhostButton theme={theme} label="Cancel" />
          </View>
        </Section>

        <Section title="Dropzone (idle)">
          <DropzonePreview theme={theme} />
        </Section>

        <Section title="Input field">
          <InputPreview theme={theme} />
        </Section>

        <Section title="Progress bar">
          <ProgressBarPreview theme={theme} />
        </Section>

        <Section title="Card + busy dot">
          <View
            style={[
              styles.card,
              { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
            ]}
          >
            <View style={styles.cardHead}>
              <Text style={[styles.cardTitle, { color: theme.text.primary }]}>Converting…</Text>
              <View style={[styles.busyDot, { backgroundColor: theme.accent.primary }]} />
            </View>
            <Text style={[styles.cardSub, { color: theme.text.secondary }]}>
              video.mp4 → output.webm
            </Text>
          </View>
        </Section>

        <Section title="Format chip group (samples)">
          <View style={styles.chipRow}>
            <FormatChipPreview theme={theme} label="mp4" selected />
            <FormatChipPreview theme={theme} label="webm" />
            <FormatChipPreview theme={theme} label="mov" />
            <FormatChipPreview theme={theme} label="mkv" />
            <FormatChipPreview theme={theme} label="gif" muted />
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}

// ─── Section helper ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.text.secondary }]}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

// ─── Color swatch rows ─────────────────────────────────────────────────────

type SwatchGroup = 'bg' | 'accent' | 'text' | 'border' | 'status' | 'overlay';

function SwatchRow({ theme, group }: { theme: Theme; group: SwatchGroup }) {
  const entries = Object.entries(theme[group]) as [string, string][];
  return (
    <View style={styles.swatchGroup}>
      <Text style={[styles.swatchGroupLabel, { color: theme.text.muted }]}>{group}</Text>
      <View style={styles.swatchRow}>
        {entries.map(([key, value]) => (
          <Swatch key={key} name={key} color={String(value)} theme={theme} />
        ))}
      </View>
    </View>
  );
}

function Swatch({ name, color, theme }: { name: string; color: string; theme: Theme }) {
  return (
    <View style={styles.swatchCol}>
      <View
        style={[
          styles.swatchChip,
          {
            backgroundColor: color.startsWith('[') ? theme.bg.surface : color,
            borderColor: theme.border.subtle,
          },
        ]}
      />
      <Text style={[styles.swatchName, { color: theme.text.secondary }]} numberOfLines={1}>
        {name}
      </Text>
      <Text style={[styles.swatchValue, { color: theme.text.muted }]} numberOfLines={1}>
        {color}
      </Text>
    </View>
  );
}

// ─── Dark/Light snapshot card ──────────────────────────────────────────────

function ThemeCard({ label, t }: { label: string; t: Theme }) {
  return (
    <View
      style={[
        styles.themeCard,
        { backgroundColor: t.bg.base, borderColor: t.border.subtle },
      ]}
    >
      <Text style={[styles.themeCardLabel, { color: t.text.secondary }]}>{label}</Text>
      <View
        style={[
          styles.themeMiniCard,
          { backgroundColor: t.bg.surface, borderColor: t.border.subtle },
        ]}
      >
        <Text style={[styles.themeMiniTitle, { color: t.text.primary }]}>Convert-X</Text>
        <View
          style={[
            styles.themeMiniBtn,
            { backgroundColor: t.accent.primary },
          ]}
        >
          <Text style={[styles.themeMiniBtnText, { color: t.accent.onPrimary }]}>Convert</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Typography ────────────────────────────────────────────────────────────

function TypeRow({
  theme,
  styleKey,
  label,
}: {
  theme: Theme;
  styleKey: keyof typeof typography;
  label: string;
}) {
  const style = typography[styleKey] as object;
  return (
    <View style={styles.typeRow}>
      <Text style={[styles.typeLabel, { color: theme.text.muted }]}>{label}</Text>
      <Text style={[style, { color: theme.text.primary }]}>
        The quick brown fox jumps
      </Text>
    </View>
  );
}

// ─── Radii ─────────────────────────────────────────────────────────────────

function RadiusTile({ label, value, theme }: { label: string; value: number; theme: Theme }) {
  return (
    <View style={styles.radiusCol}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: value,
          backgroundColor: theme.accent.primary,
        }}
      />
      <Text style={[styles.radiusLabel, { color: theme.text.secondary }]}>{label}</Text>
    </View>
  );
}

function SpacingBars({ theme }: { theme: Theme }) {
  const entries = Object.entries(spacing).filter(([, v]) => v <= 32);
  return (
    <View style={{ gap: spacing.xs }}>
      {entries.map(([key, value]) => (
        <View key={key} style={styles.spacingRow}>
          <Text style={[styles.spacingLabel, { color: theme.text.muted }]}>
            {key} · {value}
          </Text>
          <View style={[styles.spacingBar, { width: value * 4, backgroundColor: theme.accent.primary }]} />
        </View>
      ))}
    </View>
  );
}

// ─── Navbar preview (port of desktop Navbar.svelte) ────────────────────────

function NavbarPreview({ theme }: { theme: Theme }) {
  const [active, setActive] = useState<'convert' | 'resize' | 'download' | 'credits'>('convert');
  const tabs = [
    { key: 'convert', label: 'Convert', busy: true },
    { key: 'resize', label: 'Resize', busy: false },
    { key: 'download', label: 'Download', busy: false },
    { key: 'credits', label: 'Credits & App', busy: false },
  ] as const;

  return (
    <View
      style={[
        styles.navbar,
        {
          backgroundColor: theme.bg.secondary,
          borderColor: theme.border.subtle,
        },
      ]}
    >
      {tabs.map((t) => {
        const isActive = active === t.key;
        return (
          <Pressable
            key={t.key}
            onPress={() => setActive(t.key)}
            style={({ pressed }) => [
              styles.tab,
              {
                backgroundColor: isActive ? theme.bg.surface : 'transparent',
                opacity: pressed && !isActive ? 0.7 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.tabLabel,
                {
                  color: isActive ? theme.text.primary : theme.text.muted,
                },
              ]}
            >
              {t.label}
            </Text>
            {t.busy ? (
              <View style={[styles.busyDot, { backgroundColor: theme.accent.primary }]} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Primary / Ghost buttons ───────────────────────────────────────────────

function PrimaryButton({
  theme,
  label,
  disabled,
}: {
  theme: Theme;
  label: string;
  disabled?: boolean;
}) {
  return (
    <View
      style={[
        styles.primaryBtn,
        {
          backgroundColor: theme.accent.primary,
          opacity: disabled ? 0.3 : 1,
        },
      ]}
    >
      <Text style={[styles.primaryBtnLabel, { color: theme.accent.onPrimary }]}>{label}</Text>
    </View>
  );
}

function GhostButton({ theme, label }: { theme: Theme; label: string }) {
  return (
    <View
      style={[
        styles.ghostBtn,
        {
          borderColor: theme.border.subtle,
        },
      ]}
    >
      <Text style={[styles.ghostBtnLabel, { color: theme.text.secondary }]}>{label}</Text>
    </View>
  );
}

// ─── Dropzone (idle) ───────────────────────────────────────────────────────

function DropzonePreview({ theme }: { theme: Theme }) {
  return (
    <View
      style={[
        styles.dropzone,
        { borderColor: theme.border.subtle, backgroundColor: theme.bg.surface },
      ]}
    >
      <View style={[styles.dropzoneIcon, { backgroundColor: theme.accent.subtle }]}>
        <Text style={{ color: theme.accent.primary, fontSize: 24, fontFamily: fontFamily.bold }}>
          +
        </Text>
      </View>
      <Text style={[styles.dropzoneTitle, { color: theme.text.primary }]}>
        Drop files here
      </Text>
      <Text style={[styles.dropzoneSub, { color: theme.text.secondary }]}>
        or tap to browse
      </Text>
    </View>
  );
}

// ─── Input field ───────────────────────────────────────────────────────────

function InputPreview({ theme }: { theme: Theme }) {
  return (
    <View
      style={[
        styles.input,
        { backgroundColor: theme.bg.surfaceSunken, borderColor: theme.border.subtle },
      ]}
    >
      <TextInput
        placeholder="https://youtube.com/..."
        placeholderTextColor={theme.text.muted}
        style={[
          styles.inputText,
          { color: theme.text.primary },
        ]}
      />
    </View>
  );
}

// ─── Progress bar ──────────────────────────────────────────────────────────

function ProgressBarPreview({ theme }: { theme: Theme }) {
  return (
    <View
      style={[
        styles.progressCard,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <View style={styles.progressHead}>
        <Text style={[styles.progressLabel, { color: theme.text.secondary }]}>Converting…</Text>
        <Text style={[styles.progressTime, { color: theme.text.muted }]}>00:42</Text>
      </View>
      <Text style={[styles.progressPct, { color: theme.text.primary }]}>67%</Text>
      <View style={[styles.progressTrack, { backgroundColor: theme.bg.surfaceSunken }]}>
        <View
          style={[
            styles.progressFill,
            { backgroundColor: theme.accent.primary, width: '67%' },
          ]}
        />
      </View>
    </View>
  );
}

// ─── Format chip ───────────────────────────────────────────────────────────

function FormatChipPreview({
  theme,
  label,
  selected,
  muted,
}: {
  theme: Theme;
  label: string;
  selected?: boolean;
  muted?: boolean;
}) {
  const bg = selected ? theme.accent.subtle : 'transparent';
  const border = selected ? theme.accent.primary : muted ? theme.border.subtle : theme.border.subtle;
  const text = selected ? theme.accent.primary : muted ? theme.text.muted : theme.text.secondary;
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: bg,
          borderColor: border,
          borderStyle: muted ? 'dashed' : 'solid',
        },
      ]}
    >
      <Text style={[styles.chipLabel, { color: text }]}>{label}</Text>
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: {
    paddingHorizontal: spacing.huge,
    gap: spacing.giant,
  },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    ...typography.display,
    flex: 1,
    textAlign: 'center',
  },
  wordmarkSub: {
    ...typography.caption,
    fontFamily: fontFamily.medium,
  },

  section: {
    gap: spacing.lg,
  },
  sectionTitle: {
    ...typography.label,
    color: undefined,
  },
  sectionBody: {
    gap: spacing.md,
  },

  // Swatches
  swatchGroup: { gap: spacing.sm },
  swatchGroupLabel: {
    ...typography.micro,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  swatchCol: { width: 88, gap: spacing.xxs },
  swatchChip: {
    width: 88,
    height: 56,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  swatchName: { ...typography.micro },
  swatchValue: { ...typography.tiny },

  // Theme cards
  themeCompareRow: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  themeCard: {
    flex: 1,
    padding: spacing.xxl,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  themeCardLabel: { ...typography.caption },
  themeMiniCard: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.lg,
  },
  themeMiniTitle: { ...typography.bodyEmph },
  themeMiniBtn: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.giant,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  themeMiniBtnText: { ...typography.body },

  // Typography
  typeRow: { gap: spacing.xxs },
  typeLabel: { ...typography.micro },

  // Radii
  radiiRow: {
    flexDirection: 'row',
    gap: spacing.huge,
    alignItems: 'flex-end',
  },
  radiusCol: { gap: spacing.xs, alignItems: 'center' },
  radiusLabel: { ...typography.micro },

  // Spacing bars
  spacingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  spacingLabel: { ...typography.micro, width: 90 },
  spacingBar: { height: 8, borderRadius: 2 },

  // Navbar
  navbar: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxxl,
    borderRadius: radius.xs + 1,
  },
  tabLabel: { ...typography.base },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  // Buttons
  btnRow: { flexDirection: 'row', gap: spacing.lg },
  primaryBtn: {
    paddingVertical: 11,
    paddingHorizontal: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  primaryBtnLabel: { ...typography.body, fontFamily: fontFamily.semibold, fontWeight: '600' },
  ghostBtn: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.giant,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  ghostBtnLabel: { ...typography.body, fontFamily: fontFamily.semibold, fontWeight: '600' },

  // Dropzone
  dropzone: {
    paddingVertical: spacing.hugeAlt,
    paddingHorizontal: spacing.huge,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    gap: spacing.md,
  },
  dropzoneIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dropzoneTitle: { ...typography.bodyLg },
  dropzoneSub: { ...typography.bodySm },

  // Input
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xs,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  inputText: { ...typography.bodyLg, paddingVertical: 0 },

  // Progress
  progressCard: {
    padding: spacing.huge,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  progressHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressLabel: { ...typography.body },
  progressTime: { ...typography.caption },
  progressPct: { ...typography.hero },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3 },

  // Card
  card: {
    padding: spacing.xxl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: { ...typography.bodyEmph },
  cardSub: { ...typography.caption },

  // Chips
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: { ...typography.caption },
});
