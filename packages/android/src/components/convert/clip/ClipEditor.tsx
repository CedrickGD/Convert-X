import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ConvertSettings, FileEntry } from '../../../state/types';
import { radius, spacing, typography, useTheme } from '../../../theme';
import { MediaPreview, MediaPreviewHandle } from './MediaPreview';
import { Playhead } from './Playhead';
import { TimelineTrack } from './TimelineTrack';
import { TrimHandle } from './TrimHandle';
import { fmtTime } from './types';

type Props = {
  file: FileEntry;
  settings: ConvertSettings;
  /** True when target format is GIF — hides audio controls in the editor. */
  isGifTarget: boolean;
  onChange: (patch: Partial<ConvertSettings>) => void;
};

/**
 * The video editor — preview + scrubbable timeline with in/out trim handles.
 *
 * Audio toggle / speed / volume / rotate / flip live in the existing
 * VideoEditControls card below. ClipEditor focuses on the visual editing
 * surface (preview + timeline) so the two compose cleanly.
 */
export function ClipEditor({ file, settings, isGifTarget, onChange }: Props) {
  const { theme } = useTheme();
  const [duration, setDuration] = useState<number>(0);
  const [trackWidth, setTrackWidth] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const previewRef = useRef<MediaPreviewHandle>(null);

  // Resolve actual trim points (fall back to full clip).
  const trimStart = settings.trimStart ?? 0;
  const trimEnd = settings.trimEnd ?? duration;
  const clipLength = Math.max(0, trimEnd - trimStart);

  const handleLoad = useCallback(
    (meta: { duration: number; width: number; height: number }) => {
      setDuration(meta.duration);
    },
    []
  );

  const handleTime = useCallback((t: number) => {
    setCurrentTime(t);
  }, []);

  const handleTrackTap = useCallback(
    (t: number) => {
      previewRef.current?.seek(t);
    },
    []
  );

  const handlePlayheadScrub = useCallback((t: number) => {
    previewRef.current?.seek(t);
  }, []);
  const handlePlayheadCommit = useCallback((t: number) => {
    previewRef.current?.seek(t);
  }, []);

  const handleTrimStartScrub = useCallback((t: number) => {
    previewRef.current?.seek(t);
  }, []);
  const handleTrimStartCommit = useCallback(
    (t: number) => {
      onChange({ trimStart: t > 0 ? t : null });
    },
    [onChange]
  );

  const handleTrimEndScrub = useCallback((t: number) => {
    previewRef.current?.seek(t);
  }, []);
  const handleTrimEndCommit = useCallback(
    (t: number) => {
      onChange({ trimEnd: t < duration ? t : null });
    },
    [onChange, duration]
  );

  // Pause preview when the editor leaves the screen.
  useEffect(() => {
    return () => {
      previewRef.current?.pause();
    };
  }, []);

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.bg.surface, borderColor: theme.border.subtle },
      ]}
    >
      <View style={styles.head}>
        <Text style={[styles.label, { color: theme.text.muted }]}>CLIP EDITOR</Text>
        {duration > 0 ? (
          <Text style={[styles.lengthBadge, { color: theme.accent.primary }]}>
            {fmtTime(clipLength)} / {fmtTime(duration)}
          </Text>
        ) : null}
      </View>

      <MediaPreview
        ref={previewRef}
        uri={file.uri}
        trimStart={settings.trimStart}
        trimEnd={settings.trimEnd}
        stripAudio={settings.stripAudio || isGifTarget}
        volume={settings.volume}
        speed={settings.speed}
        rotate={settings.rotate}
        flipH={settings.flipH}
        flipV={settings.flipV}
        onLoad={handleLoad}
        onTime={handleTime}
      />

      <View style={styles.timelineWrap}>
        <TimelineTrack
          duration={duration || 1}
          trimStart={trimStart}
          trimEnd={trimEnd || duration || 1}
          trackWidth={trackWidth}
          onTrackWidth={setTrackWidth}
          onTrackTap={handleTrackTap}
        >
          {duration > 0 && trackWidth > 0 ? (
            <>
              <Playhead
                time={currentTime}
                duration={duration}
                trackWidth={trackWidth}
                trimStart={trimStart}
                trimEnd={trimEnd}
                onScrub={handlePlayheadScrub}
                onCommit={handlePlayheadCommit}
              />
              <TrimHandle
                side="start"
                time={trimStart}
                otherTime={trimEnd}
                duration={duration}
                trackWidth={trackWidth}
                onScrub={handleTrimStartScrub}
                onCommit={handleTrimStartCommit}
              />
              <TrimHandle
                side="end"
                time={trimEnd}
                otherTime={trimStart}
                duration={duration}
                trackWidth={trackWidth}
                onScrub={handleTrimEndScrub}
                onCommit={handleTrimEndCommit}
              />
            </>
          ) : null}
        </TimelineTrack>

        <View style={styles.timeRow}>
          <Text style={[styles.timeText, { color: theme.text.secondary }]}>
            {fmtTime(trimStart)}
          </Text>
          <Text style={[styles.timeText, { color: theme.text.muted }]}>
            now {fmtTime(currentTime)}
          </Text>
          <Text style={[styles.timeText, { color: theme.text.secondary }]}>
            {fmtTime(trimEnd || duration)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.lg,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: { ...typography.micro, letterSpacing: 0.6 },
  lengthBadge: { ...typography.caption, fontWeight: '600', fontVariant: ['tabular-nums'] },
  timelineWrap: { gap: spacing.sm },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  timeText: { ...typography.caption, fontVariant: ['tabular-nums'] },
});
