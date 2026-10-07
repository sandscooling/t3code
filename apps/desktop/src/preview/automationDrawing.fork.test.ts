// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";

import { applyAutomationDrawing, type AutomationDrawingTabs } from "./automationDrawing.fork.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const key = { threadId: "thread-1", tabId: "server-tab" };

const makeDebuggee = () => ({
  webContents: {} as Electron.WebContents,
  debugger: new NodeEvents.EventEmitter() as unknown as Electron.Debugger,
});

const makeGuest = () => {
  const calls: Array<string> = [];
  let destroyed = false;
  const guest = {
    isDestroyed: () => destroyed,
    beginFrameSubscription: () => calls.push("begin"),
    endFrameSubscription: () => calls.push("end"),
  } as unknown as Electron.WebContents;
  return { guest, calls, destroy: () => (destroyed = true) };
};

/** The app window, which can go off screen and come back. */
const makeWindow = () => {
  const emitter = new NodeEvents.EventEmitter();
  let minimized = false;
  let visible = true;
  const change = (event: string, apply: () => void) => {
    apply();
    emitter.emit(event);
  };
  const window = Object.assign(emitter, {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
  }) as unknown as Electron.BrowserWindow;
  return {
    window,
    minimize: () => change("minimize", () => (minimized = true)),
    restore: () => change("restore", () => (minimized = false)),
    hide: () => change("hide", () => (visible = false)),
    show: () => change("show", () => (visible = true)),
  };
};

/** One desktop tab, "desktop-tab", rendering the server's `key`. */
const makeTabs = (
  guest: Electron.WebContents,
  options: {
    readonly window?: Electron.BrowserWindow;
    readonly unthrottle?: () => Effect.Effect<void, string>;
  } = {},
) => {
  const { unthrottle } = options;
  const calls: Array<string> = [];
  const tabs: AutomationDrawingTabs<string> = {
    window: Effect.succeed(options.window ?? makeWindow().window),
    tabs: Effect.succeed([{ tabId: "other" }, { tabId: "desktop-tab", serverTab: key }]),
    webContents: () => Effect.succeed(guest),
    unthrottle: (tabId) =>
      Effect.sync(() => calls.push(`unthrottle ${tabId}`)).pipe(
        Effect.andThen(unthrottle?.() ?? Effect.void),
      ),
    restore: (tabId) => Effect.sync(() => calls.push(`restore ${tabId}`)),
  };
  return { tabs, calls };
};

type DrawingSwitchInput = { readonly key: typeof key; readonly active: boolean };

const run = (switches: ReadonlyArray<DrawingSwitchInput>, tabs: AutomationDrawingTabs<string>) =>
  applyAutomationDrawing(Stream.fromIterable(switches), tabs);

describe("server tab drawing on the desktop", () => {
  it.effect(
    "relays the server's switches for attached tabs, and switches a departing tab off",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        host.attach(key, makeDebuggee());
        const heard = yield* host.drawing.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* host.handleCommandLine(encodeJson({ type: "drawing", ...key, active: true }));
        // A tab that is not attached here is not this desktop's to draw.
        yield* host.handleCommandLine(
          encodeJson({ type: "drawing", threadId: "thread-1", tabId: "gone", active: true }),
        );
        yield* host.handleCommandLine(encodeJson({ type: "drawing", ...key, active: false }));
        host.detach(key);
        expect(yield* Fiber.join(heard)).toEqual([
          { key, active: true },
          { key, active: false },
          { key, active: false },
        ]);
      }),
  );

  it.effect("a backend that starts fresh holds no leases, so its tabs switch off", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee());
      const heard = yield* host.drawing.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* host.events.pipe(Stream.take(1), Stream.runDrain);
      expect(yield* Fiber.join(heard)).toEqual([{ key, active: false }]);
    }),
  );

  it.effect("draws a tab while the server holds it, then restores it exactly", () =>
    Effect.gen(function* () {
      const guest = makeGuest();
      const { tabs, calls } = makeTabs(guest.guest);
      yield* run(
        [
          { key, active: true },
          { key, active: true },
          { key, active: false },
          { key, active: false },
        ],
        tabs,
      );
      expect(calls).toEqual(["unthrottle desktop-tab", "restore desktop-tab"]);
      // A shown window draws the peeking tab by itself, so no frames are copied.
      expect(guest.calls).toEqual([]);
    }),
  );

  it.effect("copies frames only while the window is minimized or hidden", () =>
    Effect.gen(function* () {
      const guest = makeGuest();
      const window = makeWindow();
      const { tabs } = makeTabs(guest.guest, { window: window.window });
      const between = (act: () => void, next: DrawingSwitchInput) =>
        Stream.fromEffect(
          Effect.sync(() => {
            act();
            return next;
          }),
        );
      yield* applyAutomationDrawing(
        Stream.make({ key, active: true }).pipe(
          Stream.concat(
            between(
              () => {
                window.minimize();
                window.restore();
                window.hide();
              },
              { key, active: true },
            ),
          ),
          Stream.concat(
            between(
              () => {
                window.show();
                window.minimize();
              },
              { key, active: false },
            ),
          ),
        ),
        tabs,
      );
      expect(guest.calls).toEqual(["begin", "end", "begin", "end", "begin", "end"]);
      // Once the server lets go, the window coming and going changes nothing.
      window.restore();
      window.minimize();
      expect(guest.calls).toHaveLength(6);
    }),
  );

  it.effect("a tab switched on while the window is minimized copies frames at once", () =>
    Effect.gen(function* () {
      const guest = makeGuest();
      const window = makeWindow();
      window.minimize();
      const { tabs } = makeTabs(guest.guest, { window: window.window });
      yield* run(
        [
          { key, active: true },
          { key, active: false },
        ],
        tabs,
      );
      expect(guest.calls).toEqual(["begin", "end"]);
    }),
  );

  it.effect("ignores a tab this desktop does not render, and an off it never switched on", () =>
    Effect.gen(function* () {
      const guest = makeGuest();
      const { tabs, calls } = makeTabs(guest.guest);
      yield* run(
        [
          { key: { threadId: "thread-1", tabId: "elsewhere" }, active: true },
          { key, active: false },
        ],
        tabs,
      );
      expect(calls).toEqual([]);
      expect(guest.calls).toEqual([]);
    }),
  );

  it.effect("restores a tab whose guest is already gone", () =>
    Effect.gen(function* () {
      const guest = makeGuest();
      const window = makeWindow();
      window.minimize();
      const { tabs, calls } = makeTabs(guest.guest, { window: window.window });
      yield* applyAutomationDrawing(
        Stream.make({ key, active: true }).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                guest.destroy();
                return { key, active: false };
              }),
            ),
          ),
        ),
        tabs,
      );
      expect(calls).toEqual(["unthrottle desktop-tab", "restore desktop-tab"]);
      expect(guest.calls).toEqual(["begin"]);
    }),
  );

  it.effect("a switch that fails does not stop the ones after it", () =>
    Effect.gen(function* () {
      const guest = makeGuest();
      let failures = 1;
      const window = makeWindow();
      window.minimize();
      const { tabs, calls } = makeTabs(guest.guest, {
        window: window.window,
        unthrottle: () => (failures-- > 0 ? Effect.fail("webview not ready") : Effect.void),
      });
      yield* run(
        [
          { key, active: true },
          { key, active: true },
        ],
        tabs,
      );
      expect(calls).toEqual(["unthrottle desktop-tab", "unthrottle desktop-tab"]);
      expect(guest.calls).toEqual(["begin"]);
    }),
  );
});
