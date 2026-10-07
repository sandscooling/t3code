// @effect-diagnostics globalTimers:off - Bounds Playwright promises, which run outside the Effect runtime.
/**
 * Fork: keeps a desktop-rendered tab drawing while the server drives it.
 *
 * The desktop parks a tab nobody shows offscreen, where Chromium draws no
 * frames: screenshots never settle (upstream #16567), animations stop, and
 * mouse and key input never lands. While a tab holds a lease the desktop gives
 * it a 1 px, nearly transparent sliver of the window and unthrottles it
 * (`apps/desktop/src/preview/automationDrawing.fork.ts`). Leases count per
 * tab. The last one lingers before switching off, so CDP work that outlives
 * its action still gets frames, and back-to-back actions do not flap.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";

import type { DesktopTabKey } from "./DesktopBrowserChannel.ts";
import { withDeadline } from "./ServerBrowserPage.fork.ts";

export const DRAWING_LINGER = Duration.seconds(1);

/** A server tab; only one the desktop renders (`desktop` set) needs a lease. */
interface DrawingTab extends DesktopTabKey {
  readonly desktop: object | null;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

export const make = Effect.fnUntraced(function* (
  draw: (key: DesktopTabKey, active: boolean) => Effect.Effect<void>,
) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  /** Each acquire bumps `generation`, which cancels a linger already counting down. */
  const leases = new Map<string, { count: number; generation: number }>();
  const recordings = new Map<string, () => void>();

  /** Holds a desktop tab drawing; the returned function lets go, once. Headless tabs always draw. */
  const acquire = (tab: DrawingTab): (() => void) => {
    if (tab.desktop === null) return constVoid;
    const key = { threadId: tab.threadId, tabId: tab.tabId };
    const id = keyOf(key);
    let lease = leases.get(id);
    if (!lease) {
      lease = { count: 0, generation: 0 };
      leases.set(id, lease);
    }
    // Sent on every acquire, not only the first: the desktop may have switched
    // the tab off on its own (a detach, a reattach, a start that failed), and
    // switching on is idempotent there.
    runFork(draw(key, true));
    const held = lease;
    held.count += 1;
    held.generation += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.count -= 1;
      if (held.count > 0) return;
      const generation = held.generation;
      runFork(
        Effect.sleep(DRAWING_LINGER).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (held.generation !== generation || leases.get(id) !== held) return Effect.void;
              leases.delete(id);
              return draw(key, false);
            }),
          ),
        ),
      );
    };
  };

  /** A server recording screencasts the tab, so the tab draws for as long as it records. */
  const recording = (tab: DrawingTab, active: boolean) => {
    const id = keyOf(tab);
    const release = recordings.get(id);
    recordings.delete(id);
    if (active) recordings.set(id, acquire(tab));
    release?.();
  };

  /** Runs one agent action inside the tab's queue, drawing (see `runAgentAction`). */
  const agentAction = <A>(tab: DrawingTab, deadlineMs: number, work: () => Promise<A>) =>
    runAgentAction(acquire(tab), deadlineMs, work);

  return { acquire, recording, agentAction };
});

/** How long past its deadline a stuck action may keep its tab drawing. */
export const DRAWING_GRACE_MS = 60_000;

/**
 * Runs one agent action, holding its drawing lease until the work settles, or
 * `DRAWING_GRACE_MS` past the deadline for work that never does. The tab's
 * queue waits for the work only until the request's own deadline: by then the
 * agent was already told it timed out, and work that never settles must not
 * wedge every later action on the tab.
 */
export const runAgentAction = <A>(
  release: () => void,
  deadlineMs: number,
  work: () => Promise<A>,
): Promise<A> => {
  const running = Promise.resolve().then(work);
  const cap = setTimeout(release, deadlineMs + DRAWING_GRACE_MS);
  const settle = () => {
    clearTimeout(cap);
    release();
  };
  running.then(settle, settle);
  return withDeadline(
    running,
    deadlineMs,
    "The browser action outlived its request; later actions on this tab no longer wait for it.",
  );
};
