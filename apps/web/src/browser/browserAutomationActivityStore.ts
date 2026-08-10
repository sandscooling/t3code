import type { PreviewAutomationOperation } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Per-thread count of in-flight agent browser requests.
 *
 * Every browser tool call funnels through `PreviewAutomationHost`, which is
 * mounted per environment at app root rather than per routed thread. Counting
 * entries and exits there is the one place that sees browser activity for
 * every thread, foreground or background.
 */

/**
 * A `status` call is a capability probe — agents use it to ask whether a
 * browser is available at all, frequently before one exists. Treating it as
 * activity would light the indicator on threads that have no browser, so it
 * is the one operation that does not count.
 */
export function browserAutomationCountsAsActivity(operation: PreviewAutomationOperation): boolean {
  return operation !== "status";
}

/**
 * How long a thread stays marked active after its last request settles.
 *
 * Most operations finish in well under a frame (a click is a single IPC round
 * trip), so without a tail the indicator would flick on and off too fast to
 * read as anything but a rendering glitch.
 */
export const BROWSER_ACTIVITY_LINGER_MS = 900;

/**
 * How long a single request may hold the indicator before it is released
 * regardless of whether the handler ever finished.
 *
 * The count is a display counter, not a ledger: it only stays accurate while
 * every `begin` is matched by a settle, and a handler that never settles
 * strands one forever, leaving a thread pulsing "agent using browser" for the
 * life of the app. Nothing recovers it, because the release lives in that
 * handler's `finally`. Renderer-side automation has several awaits that depend
 * on a live guest replying — the overlay and readiness polls, the per-tab
 * viewport queue — and a guest that goes away mid-request (crash, close, the
 * settled-thread reaper) can leave one pending.
 *
 * Every request carries the deadline the broker arms against it, so past that
 * deadline plus a grace the agent has already been handed a timeout and is no
 * longer waiting on anything. Continuing to claim the browser is being driven
 * is then simply wrong, whatever the handler is still doing.
 */
export const BROWSER_ACTIVITY_WATCHDOG_GRACE_MS = 2_000;

/** Ceiling for callers that have no request deadline of their own. */
export const BROWSER_ACTIVITY_DEFAULT_CEILING_MS = 60_000;

interface BrowserAutomationActivityState {
  readonly activeByThreadKey: Record<string, number>;
  readonly begin: (threadKey: string) => void;
  readonly release: (threadKey: string) => void;
}

export const useBrowserAutomationActivityStore = create<BrowserAutomationActivityState>()(
  (set) => ({
    activeByThreadKey: {},
    begin: (threadKey) =>
      set((state) => ({
        activeByThreadKey: {
          ...state.activeByThreadKey,
          [threadKey]: (state.activeByThreadKey[threadKey] ?? 0) + 1,
        },
      })),
    release: (threadKey) =>
      set((state) => {
        const current = state.activeByThreadKey[threadKey];
        if (current === undefined) return state;
        if (current <= 1) {
          const { [threadKey]: _settled, ...activeByThreadKey } = state.activeByThreadKey;
          return { activeByThreadKey };
        }
        return {
          activeByThreadKey: { ...state.activeByThreadKey, [threadKey]: current - 1 },
        };
      }),
  }),
);

/**
 * Mark a thread as driving its browser, returning the settle callback.
 *
 * The release is deferred by `lingerMs` so overlapping requests extend one
 * continuous active window instead of strobing between them. Calling the
 * returned function more than once is a no-op, so it is safe in a `finally`
 * that can also be reached by an error path.
 *
 * A watchdog releases the request after `ceilingMs` whether or not it settles,
 * so one stranded handler cannot pin the indicator on forever. Pass the
 * request's own deadline plus `BROWSER_ACTIVITY_WATCHDOG_GRACE_MS`; settling
 * disarms it.
 */
export function beginBrowserAutomationRequest(
  threadKey: string,
  options?: {
    readonly lingerMs?: number;
    readonly ceilingMs?: number;
  },
): () => void {
  const lingerMs = options?.lingerMs ?? BROWSER_ACTIVITY_LINGER_MS;
  const ceilingMs = options?.ceilingMs ?? BROWSER_ACTIVITY_DEFAULT_CEILING_MS;
  useBrowserAutomationActivityStore.getState().begin(threadKey);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    useBrowserAutomationActivityStore.getState().release(threadKey);
  };
  const watchdog = setTimeout(release, ceilingMs);
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    setTimeout(release, lingerMs);
  };
}

export function useThreadBrowserAutomationActive(threadKey: string): boolean {
  return useBrowserAutomationActivityStore(
    (state) => (state.activeByThreadKey[threadKey] ?? 0) > 0,
  );
}
