import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';

import {
  DOWNLOAD_DEFAULTS,
  DownloadSettings,
  FileEntry,
  ModeView,
} from './types';

const STORAGE_KEY = '@convertx/download.v1';

/** Only the credential / last-used-default fields persist (not the transient
 *  url or in-flight session). Previously the cookies pointer + Spotify creds
 *  reset on every cold start, silently logging the user out of Instagram. */
function persistableFrom(s: DownloadSettings) {
  return {
    spotifyClientId: s.spotifyClientId,
    spotifyClientSecret: s.spotifyClientSecret,
    cookiesPath: s.cookiesPath,
    category: s.category,
    format: s.format,
    quality: s.quality,
  };
}

/**
 * Download mode — Phase 6 builds the full downloader (yt-dlp wrap, multi-asset
 * probe, etc). For Phase 2 we ship the slice so the navbar's busy dot has a
 * place to read from once Phase 6 lands.
 */

export type DownloadState = {
  files: FileEntry[];
  settings: DownloadSettings;
  view: ModeView;
  cancelled: boolean;
  currentSessionId: string | null;
};

const INITIAL: DownloadState = {
  files: [],
  settings: DOWNLOAD_DEFAULTS,
  view: 'idle',
  cancelled: false,
  currentSessionId: null,
};

type Action =
  | { type: 'updateSettings'; patch: Partial<DownloadSettings> }
  | { type: 'reset' }
  | { type: 'beginSession'; sessionId: string }
  | { type: 'finishSession'; sessionId: string }
  | { type: 'cancelSession' };

function reducer(state: DownloadState, action: Action): DownloadState {
  switch (action.type) {
    case 'updateSettings':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'reset':
      return { ...INITIAL };
    case 'beginSession':
      return {
        ...state,
        view: 'converting',
        cancelled: false,
        currentSessionId: action.sessionId,
      };
    case 'finishSession':
      if (action.sessionId !== state.currentSessionId) return state;
      return { ...state, view: 'done', currentSessionId: null };
    case 'cancelSession':
      return {
        ...state,
        cancelled: true,
        currentSessionId: null,
        view: state.files.length > 0 ? 'ready' : 'idle',
      };
    default:
      return state;
  }
}

type DownloadContextValue = {
  state: DownloadState;
  busy: boolean;
  updateSettings: (patch: Partial<DownloadSettings>) => void;
  reset: () => void;
  dispatch: React.Dispatch<Action>;
};

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const hydratedRef = useRef(false);

  // Hydrate persisted creds / cookies / last-used defaults on mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const patch: Partial<DownloadSettings> = raw ? JSON.parse(raw) : {};
        // Drop a stale cookies pointer if the file is gone (re-login needed).
        // cookiesPath is stored WITHOUT the file:// scheme (yt-dlp wants a bare
        // path), but getInfoAsync treats scheme-less strings as asset lookups
        // and reports exists:false for real files — re-add the scheme to check.
        if (patch.cookiesPath) {
          const asUri = patch.cookiesPath.startsWith('file://')
            ? patch.cookiesPath
            : `file://${patch.cookiesPath}`;
          const info = await FileSystem.getInfoAsync(asUri).catch(() => null);
          if (!info || !info.exists) {
            // The app data dir can move (backup/restore, reinstall) — before
            // logging the user out, look for the file at its canonical spot.
            const canonical = `${FileSystem.documentDirectory ?? ''}cookies.txt`;
            const fallback = await FileSystem.getInfoAsync(canonical).catch(() => null);
            patch.cookiesPath =
              fallback && fallback.exists ? canonical.replace(/^file:\/\//, '') : '';
          }
        }
        if (Object.keys(patch).length > 0) dispatch({ type: 'updateSettings', patch });
      } catch {
        // ignore — fall back to defaults
      } finally {
        hydratedRef.current = true;
      }
    })();
  }, []);

  // Persist the credential / default subset whenever it changes.
  useEffect(() => {
    if (!hydratedRef.current) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(persistableFrom(state.settings))).catch(
      () => {}
    );
  }, [
    state.settings.spotifyClientId,
    state.settings.spotifyClientSecret,
    state.settings.cookiesPath,
    state.settings.category,
    state.settings.format,
    state.settings.quality,
  ]);

  const updateSettings = useCallback(
    (patch: Partial<DownloadSettings>) => dispatch({ type: 'updateSettings', patch }),
    []
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const value = useMemo<DownloadContextValue>(
    () => ({
      state,
      busy: state.view === 'converting',
      updateSettings,
      reset,
      dispatch,
    }),
    [state, updateSettings, reset]
  );

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownload(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownload must be used inside <DownloadProvider>');
  return ctx;
}
