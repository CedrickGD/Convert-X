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
  /** Writes trim onto the bound file (ConvertContext setFileTrim). */
  onTrimChange: (patch: { trimStart?: number | null; trimEnd?: number | null }) => void;
  /** Reports the probed duration so it lands on the FileEntry (target-size
   *  export needs it). */
  onDurationKnown?: (duration: number) => void;
};

/**
 * The video editor — preview + scrubbable timeline with in/out trim handles.
 * Trim reads/writes the bound FILE's trimStart/trimEnd, not settings — each
 * clip in a batch keeps its own points.
 *
 * Audio toggle / speed / volume / rotate / flip live in the existing
 * VideoEditControls card below. ClipEditor focuses on the visual editing
 * surface (preview + timeline) so the two compose cleanly.
 */
export function ClipEditor({ file, settings, isGifTarget, onTrimChange, onDurationKnown }: Props) {
  const { theme } = useTheme();
  const [duration, setDuration] = useState<number>(0);
  const [trackWidth, setTrackWidth] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const previewRef = useRef<MediaPreviewHandle>(null);

  // Resolve actual trim points (fall back to full clip).
  const trimStart = file.trimStart ?? 0;
  const trimEnd = file.trimEnd ?? duration;
  const clipLength = Math.max(0, trimEnd - trimStart);

  const handleLoad = useCallback(
    (meta: { duration: number; width: number; height: number }) => {
      setDuration(meta.duration);
      // ExoPlayer reports 0 for duration-less containers (MPEG-TS) — a
      // stored 0 would shadow the queue's own ffprobe fallback and
      // silently disable target-size mode for the file.
      if (meta.duration > 0) onDurationKnown?.(meta.duration);
      // Trim points surviving from a longer clip would render the end
      // handle past the track (unreachable behind overflow:hidden) and
      // feed ffmpeg -ss/-to beyond the input — clear anything the loaded
      // clip can't satisfy.
      if (
        (file.trimEnd != null && file.trimEnd > meta.duration) ||
        (file.trimStart != null && file.trimStart >= meta.duration)
      ) {
        onTrimChange({ trimStart: null, trimEnd: null });
      }
    },
    [file.trimStart, file.trimEnd, onTrimChange, onDurationKnown]
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
      onTrimChange({ trimStart: t > 0 ? t : null });
    },
    [onTrimChange]
  );

  const handleTrimEndScrub = useCallback((t: number) => {
    previewRef.current?.seek(t);
  }, []);
  const handleTrimEndCommit = useCallback(
    (t: number) => {
      onTrimChange({ trimEnd: t < duration ? t : null });
    },
    [onTrimChange, duration]
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
        trimStart={file.trimStart ?? null}
        trimEnd={file.trimEnd ?? null}
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
