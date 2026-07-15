/**
 * Phase 2: the main flow is a single ModeRouter screen that switches between
 * Convert / Resize / Download / Credits via SharedContext.activeMode. React
 * Navigation remains in use only for modal routes — currently the dev-only
 * StyleGuide.
 */

export type RootStackParamList = {
  Root: undefined;
  StyleGuide: undefined;
  /** platform = a key from lib/loginPlatforms (instagram, tiktok, …). */
  PlatformLogin: { platform: string };
  History: undefined;
};
