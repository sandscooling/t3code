// @effect-diagnostics globalTimers:off - Bounds Playwright promises, which run outside the Effect runtime.
/**
 * Fork: bounds work on a page that may draw no frames (upstream #16567).
 *
 * `Page.captureScreenshot` waits for the page's next frame, and a desktop tab
 * parked offscreen never draws one, so an unbounded capture hangs forever and
 * holds the tab's capture lock and action queue with it. The server keeps a
 * tab it acts on drawing (`ServerBrowser.fork.ts`), which makes this a safety
 * net: a snapshot whose capture still times out answers with its text.
 */
import type { PreviewAutomationSnapshot } from "@t3tools/contracts";

/** A drawing page answers a capture in well under 100 ms. */
export const CAPTURE_DEADLINE_MS = 5_000;

/** Named `TimeoutError` so `toOperationError` reports it as a timeout. */
class DeadlineError extends Error {
  override readonly name = "TimeoutError";
}

/** Rejects with a timeout once `ms` pass, without cancelling `work`. */
export const withDeadline = <A>(work: Promise<A>, ms: number, message: string): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
};

export const withCaptureDeadline = <A>(capture: Promise<A>): Promise<A> =>
  withDeadline(
    capture,
    CAPTURE_DEADLINE_MS,
    `The page drew no frame to capture within ${CAPTURE_DEADLINE_MS / 1000} s.`,
  );

/** A 1x1 transparent PNG, standing in for a capture that timed out. */
export const UNAVAILABLE_SCREENSHOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

const UNAVAILABLE_SCREENSHOT_NOTE = `[Screenshot unavailable: the page drew no frame within ${CAPTURE_DEADLINE_MS / 1000} s. The text and accessibility tree are current.]\n\n`;

/** Catches a snapshot's capture: a timeout becomes the placeholder, anything else still fails. */
export const screenshotUnavailable = (cause: unknown): string => {
  if (cause instanceof DeadlineError) return UNAVAILABLE_SCREENSHOT_PNG;
  throw cause;
};

/**
 * The note for a result that carries the saved screenshot's path but not the
 * snapshot's text, so the agent still learns the file is a placeholder.
 */
export const unavailableScreenshotNote = (screenshot: { readonly data: string }) =>
  screenshot.data === UNAVAILABLE_SCREENSHOT_PNG
    ? { note: UNAVAILABLE_SCREENSHOT_NOTE.trim() }
    : {};

/** Tells the agent the snapshot's image is a placeholder, and sizes it honestly. */
export const noteUnavailableScreenshot = (
  snapshot: PreviewAutomationSnapshot,
): PreviewAutomationSnapshot =>
  snapshot.screenshot.data === UNAVAILABLE_SCREENSHOT_PNG
    ? {
        ...snapshot,
        visibleText: UNAVAILABLE_SCREENSHOT_NOTE + snapshot.visibleText,
        screenshot: { ...snapshot.screenshot, width: 1, height: 1 },
      }
    : snapshot;
