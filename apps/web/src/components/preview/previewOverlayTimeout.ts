/**
 * How long the renderer may wait for a tab's desktop overlay before giving up.
 *
 * The server arms its own timer for the same operation deadline, so spending the
 * whole budget here makes the two expire together and lets the server win the
 * race. That replaces the renderer's specific "no overlay" error - the one that
 * explains a tab was never automatable - with an opaque server-side timeout, so
 * the wait deliberately finishes early enough for its error to travel back.
 */
export const OVERLAY_TIMEOUT_RESERVE_MS = 1_000;

export const previewOverlayBudgetMs = (timeoutMs: number): number =>
  Math.max(timeoutMs - OVERLAY_TIMEOUT_RESERVE_MS, Math.ceil(timeoutMs / 2));
