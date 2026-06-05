import { Check, Plus, X } from 'lucide-react-native';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { prettyBytes } from '../../lib/formats';
import type { FileEntry } from '../../state/types';
import { radius, spacing, typography, useTheme } from '../../theme';

type Props = {
  files: FileEntry[];
  /** "ready" lets users remove + add. "converting" / "done" lock the list. */
  view: 'ready' | 'converting' | 'done';
  onRemoveFile?: (id: string) => void;
  onAddFiles?: () => void;
};

// Media-type indicator dot — these are NOT theme tokens; they're informational
// colors tied to media types (blue=video, purple=audio, emerald=image) and
// mirror desktop FileList.svelte.
const TYPE_DOT: Record<string, string> = {
  video: '#60a5fa',
  audio: '#c084fc',
  image: '#34d399',
  unknown: '#999999',
};

/**
 * Port of desktop FileList.svelte.
 *
 * Compact rows, scrollable. Per-row: color dot, name + meta, status pill
 * or inline progress bar, remove button (ready view only).
 */
export function FileList({ files, view, onRemoveFile, onAddFiles }: Props) {
  const { theme } = useTheme();

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: theme.border.subtle }]}>
        <Text style={[styles.headerLabel, { color: theme.text.muted }]}>
          {files.length} FILE{files.length !== 1 ? 'S' : ''}
        </Text>
        {view === 'ready' && onAddFiles ? (
          <Pressable
            onPress={onAddFiles}
            style={({ pressed }) => [
              styles.addBtn,
              {
                borderColor: pressed ? theme.accent.primary : theme.border.subtle,
                backgroundColor: pressed ? theme.accent.subtle : 'transparent',
              },
            ]}
          >
            <Plus size={12} strokeWidth={2.2} color={theme.accent.primary} />
            <Text style={[styles.addBtnText, { color: theme.accent.primary }]}>Add</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {files.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            view={view}
            theme={theme}
            onRemove={onRemoveFile ? () => onRemoveFile(f.id) : undefined}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function FileRow({
  file,
  view,
  theme,
  onRemove,
}: {
  file: FileEntry;
  view: 'ready' | 'converting' | 'done';
  theme: ReturnType<typeof useTheme>['theme'];
  onRemove?: () => void;
}) {
  const dot = TYPE_DOT[file.mediaType] ?? TYPE_DOT.unknown;
  const isConverting = file.status === 'converting';
  const isDone = file.status === 'done';
  const isError = file.status === 'error';

  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <View style={styles.rowBody}>
        <Text
          numberOfLines={1}
          style={[styles.name, { color: theme.text.primary }]}
        >
          {file.outputName ?? file.name}
        </Text>
        {isConverting ? (
          <View style={styles.progressRow}>
            <View
              style={[styles.progressTrack, { backgroundColor: theme.bg.surfaceSunken }]}
            >
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: theme.accent.primary, width: `${file.progress}%` },
                ]}
              />
            </View>
            <Text style={[styles.progressPct, { color: theme.text.muted }]}>
              {file.progress}%
            </Text>
          </View>
        ) : (
          <Text style={[styles.meta, { color: theme.text.muted }]}>
            {isError
              ? file.error ?? 'Failed'
              : isDone
              ? `${prettyBytes(file.outputBytes ?? 0)} · saved`
              : `${prettyBytes(file.bytes)} · ${file.mediaType}`}
          </Text>
        )}
      </View>
      {isDone ? (
        <View style={[styles.statusBadge, { backgroundColor: theme.accent.subtle }]}>
          <Check size={12} strokeWidth={2.4} color={theme.accent.primary} />
        </View>
      ) : isError ? (
        <View style={[styles.statusBadge, { backgroundColor: theme.status.errorDim }]}>
          <X size={12} strokeWidth={2.4} color={theme.status.error} />
        </View>
      ) : view === 'ready' && onRemove ? (
        <Pressable
          hitSlop={8}
          onPress={onRemove}
          style={({ pressed }) => [styles.removeBtn, { opacity: pressed ? 0.5 : 1 }]}
        >
          <X size={14} strokeWidth={2} color={theme.text.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLabel: { ...typography.micro, letterSpacing: 0.6 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
  },
  addBtnText: { ...typography.micro, fontWeight: '600' },
  scroll: { maxHeight: 280 },
  scrollContent: { paddingVertical: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowBody: { flex: 1, gap: 2 },
  name: { ...typography.base },
  meta: { ...typography.micro },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 2,
  },
  progressTrack: { flex: 1, height: 3, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  progressPct: { ...typography.tiny, minWidth: 28, textAlign: 'right' },
  statusBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtn: { padding: 4 },
});
