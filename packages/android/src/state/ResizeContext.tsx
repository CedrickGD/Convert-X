import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from 'react';

import {
  FileEntry,
  ModeView,
  RESIZE_DEFAULTS,
  ResizeSettings,
} from './types';

/**
 * Resize mode — same shape as Convert but with its own settings and queue.
 *
 * Phase 2 ships the slice + reducer; Phase 5 builds the UI and connects it
 * to a resize-specific queue.
 */

export type ResizeState = {
  files: FileEntry[];
  settings: ResizeSettings;
  view: ModeView;
  cancelled: boolean;
  currentSessionId: string | null;
};

const INITIAL: ResizeState = {
  files: [],
  settings: RESIZE_DEFAULTS,
  view: 'idle',
  cancelled: false,
  currentSessionId: null,
};

type Action =
  | { type: 'addFiles'; files: FileEntry[] }
  | { type: 'removeFile'; id: string }
  | { type: 'updateSettings'; patch: Partial<ResizeSettings> }
  | { type: 'reset' }
  | { type: 'beginSession'; sessionId: string }
  | { type: 'fileStatus'; sessionId: string; id: string; status: FileEntry['status']; progress?: number }
  | { type: 'fileProgress'; sessionId: string; id: string; progress: number }
  | { type: 'fileResult'; sessionId: string; id: string; outputUri: string; outputName: string; outputBytes: number }
  | { type: 'fileError'; sessionId: string; id: string; error: string }
  | { type: 'finishSession'; sessionId: string }
  | { type: 'cancelSession' };

function reducer(state: ResizeState, action: Action): ResizeState {
  switch (action.type) {
    case 'addFiles': {
      const next = [...state.files, ...action.files];
      return { ...state, files: next, view: next.length > 0 ? 'ready' : 'idle' };
    }
    case 'removeFile': {
      const next = state.files.filter((f) => f.id !== action.id);
      return { ...state, files: next, view: next.length === 0 ? 'idle' : state.view };
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

type ResizeContextValue = {
  state: ResizeState;
  busy: boolean;
  addFiles: (files: FileEntry[]) => void;
  removeFile: (id: string) => void;
  updateSettings: (patch: Partial<ResizeSettings>) => void;
  reset: () => void;
  dispatch: React.Dispatch<Action>;
  beginSession: () => string;
  cancel: () => void;
};

const ResizeContext = createContext<ResizeContextValue | null>(null);

let nextSessionId = 1;

export function ResizeProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const addFiles = useCallback(
    (files: FileEntry[]) => dispatch({ type: 'addFiles', files }),
    []
  );
  const removeFile = useCallback((id: string) => dispatch({ type: 'removeFile', id }), []);
  const updateSettings = useCallback(
    (patch: Partial<ResizeSettings>) => dispatch({ type: 'updateSettings', patch }),
    []
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const beginSession = useCallback(() => {
    const id = `resize-${Date.now()}-${nextSessionId++}`;
    dispatch({ type: 'beginSession', sessionId: id });
    return id;
  }, []);
  const cancel = useCallback(() => dispatch({ type: 'cancelSession' }), []);

  const value = useMemo<ResizeContextValue>(
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

  return <ResizeContext.Provider value={value}>{children}</ResizeContext.Provider>;
}

export function useResize(): ResizeContextValue {
  const ctx = useContext(ResizeContext);
  if (!ctx) throw new Error('useResize must be used inside <ResizeProvider>');
  return ctx;
}
