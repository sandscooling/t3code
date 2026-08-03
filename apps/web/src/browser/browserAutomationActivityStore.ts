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
 */
export function beginBrowserAutomationRequest(
  threadKey: string,
  options?: {
    readonly lingerMs?: number;
    readonly setTimeoutFn?: typeof globalThis.setTimeout;
  },
): () => void {
  const lingerMs = options?.lingerMs ?? BROWSER_ACTIVITY_LINGER_MS;
  const setTimeoutFn = options?.setTimeoutFn ?? globalThis.setTimeout;
  useBrowserAutomationActivityStore.getState().begin(threadKey);
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    setTimeoutFn(() => {
      useBrowserAutomationActivityStore.getState().release(threadKey);
    }, lingerMs);
  };
}

export function useThreadBrowserAutomationActive(threadKey: string): boolean {
  return useBrowserAutomationActivityStore(
    (state) => (state.activeByThreadKey[threadKey] ?? 0) > 0,
  );
}
