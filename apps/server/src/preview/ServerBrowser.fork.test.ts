import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, it as vitestIt, vi } from "vite-plus/test";

import * as ServerBrowserFork from "./ServerBrowser.fork.ts";
import { toOperationError } from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

const desktopTab = { threadId: "thread", tabId: "tab", desktop: {} };
const headlessTab = { threadId: "thread", tabId: "headless", desktop: null };

/** Lets the forked drawing switches run. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
});

const makeDrawing = Effect.gen(function* () {
  const switches: Array<boolean> = [];
  const drawing = yield* ServerBrowserFork.make((_key, active) =>
    Effect.sync(() => switches.push(active)),
  );
  return { drawing, switches };
});

describe("desktop tab drawing", () => {
  it.effect("draws from the first lease until a linger after the last", () =>
    Effect.gen(function* () {
      const { drawing, switches } = yield* makeDrawing;
      const first = drawing.acquire(desktopTab);
      const second = drawing.acquire(desktopTab);
      yield* settle;
      expect(switches).toEqual([true, true]);
      first();
      first();
      second();
      yield* TestClock.adjust(Duration.millis(999));
      expect(switches).toEqual([true, true]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* settle;
      expect(switches).toEqual([true, true, false]);
    }),
  );

  it.effect("an action during the linger keeps the tab drawing without switching off", () =>
    Effect.gen(function* () {
      const { drawing, switches } = yield* makeDrawing;
      drawing.acquire(desktopTab)();
      yield* TestClock.adjust(Duration.millis(500));
      const next = drawing.acquire(desktopTab);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* settle;
      expect(switches).toEqual([true, true]);
      next();
      yield* TestClock.adjust(ServerBrowserFork.DRAWING_LINGER);
      yield* settle;
      expect(switches).toEqual([true, true, false]);
    }),
  );

  it.effect("an action during the linger switches back on a tab the desktop reset", () =>
    Effect.gen(function* () {
      // The desktop's own view: the server's switches set it, a detach clears it.
      let desktopDrawing = false;
      const drawing = yield* ServerBrowserFork.make((_key, active) =>
        Effect.sync(() => {
          desktopDrawing = active;
        }),
      );
      drawing.acquire(desktopTab)();
      yield* settle;
      expect(desktopDrawing).toBe(true);
      // The guest crashed or devtools opened: the desktop detached it and switched it off.
      desktopDrawing = false;
      // The agent's next action lands inside the linger, after the tab reattached.
      yield* TestClock.adjust(Duration.millis(500));
      const next = drawing.acquire(desktopTab);
      yield* settle;
      expect(desktopDrawing).toBe(true);
      next();
      yield* TestClock.adjust(ServerBrowserFork.DRAWING_LINGER);
      yield* settle;
      expect(desktopDrawing).toBe(false);
    }),
  );

  it.effect("a headless tab always draws, so it never asks", () =>
    Effect.gen(function* () {
      const { drawing, switches } = yield* makeDrawing;
      drawing.acquire(headlessTab)();
      drawing.recording(headlessTab, true);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* settle;
      expect(switches).toEqual([]);
    }),
  );

  it.effect("a recording keeps the tab drawing between actions until it stops", () =>
    Effect.gen(function* () {
      const { drawing, switches } = yield* makeDrawing;
      drawing.recording(desktopTab, true);
      drawing.acquire(desktopTab)();
      yield* TestClock.adjust(Duration.seconds(5));
      yield* settle;
      expect(switches).toEqual([true, true]);
      drawing.recording(desktopTab, false);
      drawing.recording(desktopTab, false);
      yield* TestClock.adjust(ServerBrowserFork.DRAWING_LINGER);
      yield* settle;
      expect(switches).toEqual([true, true, false]);
    }),
  );

  it.effect("an action holds the tab drawing until its work settles", () =>
    Effect.gen(function* () {
      const { drawing, switches } = yield* makeDrawing;
      const work = Promise.withResolvers<string>();
      const action = drawing.agentAction(desktopTab, 60_000, () => work.promise);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* settle;
      expect(switches).toEqual([true]);
      work.resolve("done");
      expect(yield* Effect.promise(() => action)).toBe("done");
      yield* TestClock.adjust(ServerBrowserFork.DRAWING_LINGER);
      yield* settle;
      expect(switches).toEqual([true, false]);
    }),
  );
});

describe("agent action deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  vitestIt("frees the tab's queue once the request's deadline passes", async () => {
    vi.useFakeTimers();
    const control = new SessionControl("agent");
    const release = vi.fn();
    // A capture of a page that draws no frames never settles.
    const stuck = control.agent("agent", () =>
      ServerBrowserFork.runAgentAction(release, 15_000, () => new Promise<never>(() => {})),
    );
    const stuckOutcome = stuck.then(
      () => null,
      (error: unknown) => error,
    );
    const next = control.agent("agent", async () => "next ran");
    await vi.advanceTimersByTimeAsync(14_999);
    const raced = await Promise.race([next, Promise.resolve("still waiting")]);
    expect(raced).toBe("still waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(toOperationError(await stuckOutcome).tag).toBe("PreviewAutomationTimeoutError");
    await expect(next).resolves.toBe("next ran");
    // The stuck work may still need frames to finish, but not forever.
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ServerBrowserFork.DRAWING_GRACE_MS);
    expect(release).toHaveBeenCalledOnce();
  });

  vitestIt("lets the drawing go as soon as the work settles, and only once", async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    await ServerBrowserFork.runAgentAction(release, 15_000, async () => "done");
    expect(release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000 + ServerBrowserFork.DRAWING_GRACE_MS);
    expect(release).toHaveBeenCalledOnce();
  });
});
