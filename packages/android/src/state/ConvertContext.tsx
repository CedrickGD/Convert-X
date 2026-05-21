import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from 'react';

import {
  CONVERT_DEFAULTS,
  ConvertSettings,
  FileEntry,
  ModeView,
} from './types';

/**
 * Convert mode state slice.
 *
 * Files + settings + view + currentSessionId live here. The actual conversion
 * loop lives in src/lib/conversionQueue.ts so unmounting this provider does
 * not kill in-flight work. The queue calls back into us via the actions
 * exposed on the hook — those actions dispatch reducer events, and the
 * reducer ignores callbacks whose sessionId no longer matches.
 */

export type ConvertState = {
  files: FileEntry[];
  settings: ConvertSettings;
  view: ModeView;
  cancelled: boolean;
  /** Identifies the in-flight session. Stale callbacks are dropped. */
  currentSessionId: string | null;
};

const INITIAL: ConvertState = {
  files: [],
  settings: CONVERT_DEFAULTS,
  view: 'idle',
  cancelled: false,
  currentSessionId: null,
};

type Action =
  | { type: 'addFiles'; files: FileEntry[] }
  | { type: 'removeFile'; id: string }
  | { type: 'updateSettings'; patch: Partial<ConvertSettings> }
  | { type: 'reset' }
  | { type: 'beginSession'; sessionId: string }
  | { type: 'fileStatus'; sessionId: string; id: string; status: FileEntry['status']; progress?: number }
  | { type: 'fileResult'; sessionId: string; id: string; outputUri: string; outputName: string; outputBytes: number }
  | { type: 'fileError'; sessionId: string; id: string; error: string }
  | { type: 'fileProgress'; sessionId: string; id: string; progress: number }
  | { type: 'finishSession'; sessionId: string }
  | { type: 'cancelSession' };

function reducer(state: ConvertState, action: Action): ConvertState {
  switch (action.type) {
    case 'addFiles': {
      const next = [...state.files, ...action.files];
      return {
        ...state,
        files: next,
        view: next.length > 0 ? 'ready' : 'idle',
      };
    }
    case 'removeFile': {
      const next = state.files.filter((f) => f.id !== action.id);
      return {
        ...state,
        files: next,
        view: next.length === 0 ? 'idle' : state.view,
      };
    }
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
        files: state.files.map((f) =>
          f.status === 'error' ? f : { ...f, status: 'queued', progress: 0 }
        ),
      };
    // From here on, drop any callback whose sessionId no longer matches —
    // that means cancel happened or a new session started.
    case 'fileStatus':
      if (action.sessionId !== state.currentSessionId) return state;
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id
            ? { ...f, status: action.status, progress: action.progress ?? f.progress }
            : f
        ),
      };
    case 'fileProgress':
      if (action.sessionId !== state.currentSessionId) return state;
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id ? { ...f, progress: action.progress } : f
        ),
      };
    case 'fileResult':
      if (action.sessionId !== state.currentSessionId) return state;
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id
            ? {
                ...f,
                status: 'done',
                progress: 100,
                outputUri: action.outputUri,
                outputName: action.outputName,
                outputBytes: action.outputBytes,
              }
            : f
        ),
      };
    case 'fileError':
      if (action.sessionId !== state.currentSessionId) return state;
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id ? { ...f, status: 'error', error: action.error } : f
        ),
      };
    case 'finishSession':
      if (action.sessionId !== state.currentSessionId) return state;
      return { ...state, view: 'done', currentSessionId: null };
    case 'cancelSession':
      return {
        ...state,
        cancelled: true,
        currentSessionId: null,
        view: state.files.some((f) => f.status === 'done') ? 'done' : 'ready',
        files: state.files.map((f) =>
          f.status === 'queued' || f.status === 'converting'
            ? { ...f, status: 'ready', progress: 0 }
            : f
        ),
      };
    default:
      return state;
  }
}

type ConvertContextValue = {
  state: ConvertState;
  busy: boolean;
  addFiles: (files: FileEntry[]) => void;
  removeFile: (id: string) => void;
  updateSettings: (patch: Partial<ConvertSettings>) => void;
  reset: () => void;
  /** Called by the conversion queue — not from UI. */
  dispatch: React.Dispatch<Action>;
  /** Begin a new session (called by the start-convert action). */
  beginSession: () => string;
  cancel: () => void;
};

const ConvertContext = createContext<ConvertContextValue | null>(null);

let nextSessionId = 1;

export function ConvertProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const addFiles = useCallback(
    (files: FileEntry[]) => dispatch({ type: 'addFiles', files }),
    []
  );
  const removeFile = useCallback((id: string) => dispatch({ type: 'removeFile', id }), []);
  const updateSettings = useCallback(
    (patch: Partial<ConvertSettings>) => dispatch({ type: 'updateSettings', patch }),
    []
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const beginSession = useCallback(() => {
    const id = `convert-${Date.now()}-${nextSessionId++}`;
    dispatch({ type: 'beginSession', sessionId: id });
    return id;
  }, []);
  const cancel = useCallback(() => dispatch({ type: 'cancelSession' }), []);

  const value = useMemo<ConvertContextValue>(
    () => ({
      state,
      busy: state.view === 'converting',
      addFiles,
      removeFile,
      updateSettings,
      reset,
      dispatch,
      beginSession,
      cancel,
    }),
    [state, addFiles, removeFile, updateSettings, reset, beginSession, cancel]
  );

  return <ConvertContext.Provider value={value}>{children}</ConvertContext.Provider>;
}

export function useConvert(): ConvertContextValue {
  const ctx = useContext(ConvertContext);
  if (!ctx) throw new Error('useConvert must be used inside <ConvertProvider>');
  return ctx;
}
