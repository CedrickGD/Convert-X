import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from 'react';

import {
  DOWNLOAD_DEFAULTS,
  DownloadSettings,
  FileEntry,
  ModeView,
} from './types';

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
