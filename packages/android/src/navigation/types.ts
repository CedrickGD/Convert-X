/**
 * Phase 2: the main flow is no longer a bottom tab navigator — it's a single
 * ModeRouter screen that switches between Convert / Resize / Download /
 * Credits via SharedContext.activeMode. React Navigation remains in use for
 * modal-style routes (StyleGuide today; ColorPicker is a legacy modal that
 * Phase 3 removes).
 */

export type RootStackParamList = {
  Root: undefined;
  StyleGuide: undefined;
  /** @deprecated Removed in Phase 3 along with the multi-accent picker. */
  ColorPicker: undefined;
};
