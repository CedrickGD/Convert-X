import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import { Mode } from './types';

/**
 * Lightweight global slice — just the active mode for now.
 * Theme lives in ThemeProvider; we don't double-store it here.
 */

type SharedContextValue = {
  activeMode: Mode;
  /** ONLY changes the visual tab. Never touches per-mode state. */
  switchMode: (m: Mode) => void;
};

const SharedContext = createContext<SharedContextValue | null>(null);

export function SharedProvider({ children }: { children: React.ReactNode }) {
  const [activeMode, setActiveMode] = useState<Mode>('convert');

  const switchMode = useCallback((m: Mode) => {
    setActiveMode(m);
  }, []);

  const value = useMemo<SharedContextValue>(
    () => ({ activeMode, switchMode }),
    [activeMode, switchMode]
  );

  return <SharedContext.Provider value={value}>{children}</SharedContext.Provider>;
}

export function useShared(): SharedContextValue {
  const ctx = useContext(SharedContext);
  if (!ctx) throw new Error('useShared must be used inside <SharedProvider>');
  return ctx;
}
