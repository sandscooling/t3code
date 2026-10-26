/**
 * Fork: keeps a server tab drawing while the server holds its lease (server `ServerBrowser.fork.ts`).
 * A parked offscreen `<webview>` draws no frames, so this unthrottles the guest and window through
 * the "automation" frame-capture consumer, and the renderer gives it a 1 px sliver (web
 * `agentDrawing.fork.ts`). Minimized or hidden, it also subscribes to frames, copying each one.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

type DrawingSwitch = {
  readonly key: DesktopBrowserHost.DesktopBrowserTabKey;
  readonly active: boolean;
};

/** What the preview manager lends this: its window, its tabs and its frame-capture consumer. */
export interface AutomationDrawingTabs<E> {
  readonly window: Effect.Effect<Electron.BrowserWindow | undefined>;
  readonly tabs: Effect.Effect<
    Iterable<{
      readonly tabId: string;
      readonly serverTab?: DesktopBrowserHost.DesktopBrowserTabKey | undefined;
    }>
  >;
  readonly webContents: (tabId: string) => Effect.Effect<Electron.WebContents, E>;
  readonly unthrottle: (tabId: string) => Effect.Effect<void, E>;
  readonly restore: (tabId: string) => Effect.Effect<void, E>;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserHost.DesktopBrowserTabKey) =>
  `${threadId}\u0000${tabId}`;

const offScreen = (window: Electron.BrowserWindow) =>
  !window.isDestroyed() && (window.isMinimized() || !window.isVisible());

interface DrawingTab {
  readonly tabId: string;
  readonly guest: Electron.WebContents;
  subscribed: boolean;
}

/** Applies the server's drawing switches, in order, for the manager's lifetime. */
export const applyAutomationDrawing = Effect.fn("desktop.preview.applyAutomationDrawing")(function <
  E,
>(switches: Stream.Stream<DrawingSwitch>, tabs: AutomationDrawingTabs<E>) {
  const drawing = new Map<string, DrawingTab>();
  const watchedWindows = new WeakSet<Electron.BrowserWindow>();

  const subscribe = (tab: DrawingTab, wanted: boolean) => {
    if (tab.subscribed === wanted || tab.guest.isDestroyed()) return;
    if (wanted) tab.guest.beginFrameSubscription(false, () => {});
    else tab.guest.endFrameSubscription();
    tab.subscribed = wanted;
  };
  /** Follows the window on and off screen; with nothing drawing it does nothing. */
  const watch = (window: Electron.BrowserWindow) => {
    if (watchedWindows.has(window)) return;
    watchedWindows.add(window);
    const sync = () => {
      const wanted = offScreen(window);
      for (const tab of drawing.values()) subscribe(tab, wanted);
    };
    window.on("minimize", sync);
    window.on("restore", sync);
    window.on("hide", sync);
    window.on("show", sync);
  };

  const stop = Effect.fn("desktop.preview.stopAutomationDrawing")(function* (id: string) {
    const current = drawing.get(id);
    if (!current) return;
    drawing.delete(id);
    subscribe(current, false);
    yield* tabs.restore(current.tabId);
  });
  const start = Effect.fn("desktop.preview.startAutomationDrawing")(function* (id: string) {
    let tabId: string | undefined;
    for (const tab of yield* tabs.tabs) {
      if (tab.serverTab && keyOf(tab.serverTab) === id) tabId = tab.tabId;
    }
    if (tabId === undefined) return;
    const guest = yield* tabs.webContents(tabId);
    const current = drawing.get(id);
    if (current?.tabId === tabId && current.guest === guest) return;
    // A swapped guest (crash recovery) starts over.
    yield* stop(id);
    yield* tabs.unthrottle(tabId);
    const tab: DrawingTab = { tabId, guest, subscribed: false };
    drawing.set(id, tab);
    const window = yield* tabs.window;
    if (window === undefined) return;
    watch(window);
    subscribe(tab, offScreen(window));
  });
  return switches.pipe(
    Stream.runForEach(({ key, active }) => {
      const id = keyOf(key);
      return (active ? start(id) : stop(id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not switch a server tab's drawing.", { key, active, cause }),
        ),
      );
    }),
  );
});

/** Tells the renderer which server tabs to place where they can draw. */
export const forwardAutomationDrawing = Effect.fn("desktop.preview.forwardAutomationDrawing")(
  function* () {
    const host = yield* DesktopBrowserHost.DesktopBrowserHost;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* host.drawing.pipe(
      Stream.runForEach(({ key, active }) =>
        electronWindow.sendAll(IpcChannels.PREVIEW_AUTOMATION_DRAWING_CHANNEL, { ...key, active }),
      ),
      Effect.forkScoped,
    );
  },
);
