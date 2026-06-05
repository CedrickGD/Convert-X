import { useEventListener } from 'expo';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Pause, Play } from 'lucide-react-native';
import React, { useEffect, useImperativeHandle, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, typography, useTheme } from '../../../theme';
import { fmtTime, RotateDeg } from './types';

export type MediaPreviewHandle = {
  seek: (timeSec: number) => void;
  pause: () => void;
};

type Props = {
  uri: string;
  /** When provided, the player initial position. */
  trimStart: number | null;
  /** When provided, capped end of playback. */
  trimEnd: number | null;
  stripAudio: boolean;
  volume: number; // 0..200; expo-video clamps to 0..1
  speed: number;  // 0.1..10
  rotate: RotateDeg;
  flipH: boolean;
  flipV: boolean;
  /** Fires once playback metadata is known. */
  onLoad?: (meta: { duration: number; width: number; height: number }) => void;
  /** Fires every ~250ms during playback so the timeline playhead can follow. */
  onTime?: (currentTime: number) => void;
};

/**
 * Wraps expo-video. Owns the player + applies the editor settings live.
 * Imperative handle lets the timeline drag the playhead and seek the video.
 */
export const MediaPreview = React.forwardRef<MediaPreviewHandle, Props>(function MediaPreview(
  { uri, trimStart, trimEnd, stripAudio, volume, speed, rotate, flipH, flipV, onLoad, onTime },
  ref
) {
  const { theme } = useTheme();
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = stripAudio;
    p.volume = Math.min(1, Math.max(0, volume / 100));
    p.playbackRate = Math.max(0.1, Math.min(10, speed));
    p.timeUpdateEventInterval = 0.25;
  });

  useEffect(() => {
    player.muted = stripAudio;
  }, [player, stripAudio]);
  useEffect(() => {
    player.volume = Math.min(1, Math.max(0, volume / 100));
  }, [player, volume]);
  useEffect(() => {
    try {
      player.playbackRate = Math.max(0.1, Math.min(10, speed));
    } catch {
      // Some Android devices reject extreme rates — silently fall back.
    }
  }, [player, speed]);

  // Imperative seek for the timeline gestures.
  useImperativeHandle(
    ref,
    () => ({
      seek: (t: number) => {
        player.currentTime = t;
        setCurrentTime(t);
      },
      pause: () => {
        player.pause();
        setPlaying(false);
      },
    }),
    [player]
  );

  // statusChange fires when video is ready — pull duration + dimensions.
  useEventListener(player, 'statusChange', (event) => {
    if (event.status === 'readyToPlay' && onLoad) {
      const duration = player.duration || 0;
      const videoSource = (player as unknown as { videoSource: { width?: number; height?: number } | null }).videoSource;
      const width = videoSource?.width ?? 0;
      const height = videoSource?.height ?? 0;
      onLoad({ duration, width, height });
    }
  });

  // Wall-clock position follow.
  useEventListener(player, 'timeUpdate', (e) => {
    setCurrentTime(e.currentTime);
    if (onTime) onTime(e.currentTime);
    // Auto-pause when we cross trimEnd.
    if (trimEnd != null && e.currentTime >= trimEnd && playing) {
      player.pause();
      setPlaying(false);
    }
  });

  useEventListener(player, 'playingChange', (e) => {
    setPlaying(e.isPlaying);
  });

  const togglePlay = () => {
    if (playing) {
      player.pause();
    } else {
      // Snap into the trim window if the head is outside.
      if (trimStart != null && (currentTime < trimStart || currentTime >= (trimEnd ?? Number.POSITIVE_INFINITY))) {
        player.currentTime = trimStart;
      }
      player.play();
    }
  };

  // CSS-style affine transform for rotate/flip preview (FFmpeg applies real pixel rotation at export).
  const transform = [
    { rotate: `${rotate}deg` },
    { scaleX: flipH ? -1 : 1 },
    { scaleY: flipV ? -1 : 1 },
  ];

  return (
    <View style={[styles.frame, { backgroundColor: '#000', borderColor: theme.border.subtle }]}>
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFillObject, { transform }]}
        contentFit="contain"
        nativeControls={false}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable
          onPress={togglePlay}
          style={({ pressed }) => [
            styles.playBtn,
            {
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          {playing ? (
            <Pause size={20} strokeWidth={2} color="#fff" />
          ) : (
            <Play size={20} strokeWidth={2} color="#fff" />
          )}
        </Pressable>
        <View style={[styles.timeBadge, { backgroundColor: 'rgba(0, 0, 0, 0.55)' }]}>
          <Text style={styles.timeText}>{fmtTime(currentTime)}</Text>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 16 / 9,
    width: '100%',
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    padding: spacing.md,
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeBadge: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.xs,
  },
  timeText: { ...typography.caption, color: '#fff', fontVariant: ['tabular-nums'] },
});
