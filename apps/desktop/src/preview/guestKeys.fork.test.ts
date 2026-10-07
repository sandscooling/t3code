// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron guest and its debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as FrameKeys from "./frameKeys.fork.ts";
import * as GuestKeys from "./guestKeys.fork.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
  ),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/**
 * A guest webContents as Electron behaves: `sendInputEvent` emits
 * `before-input-event` synchronously for key-down and key-up, never for chars,
 * and a guest that lost its widget emits nothing.
 */
const makeGuest = (
  options: {
    readonly widget?: boolean;
    /** What the focus walk finds: a multi-line editor, or a single-line field. */
    readonly multiline?: boolean;
    /** What the page's wait for the keys answers; settled at once by default. */
    readonly settled?: Promise<boolean>;
  } = {},
) => {
  const emitter = new NodeEvents.EventEmitter();
  const sent: Array<GuestKeys.GuestKeyPacket> = [];
  const expressions: Array<string> = [];
  let waiting: () => void = () => undefined;
  /** Resolves when the reply starts waiting on the page. */
  const settling = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const agentKeyDuringEvent: Array<boolean> = [];
  emitter.on("before-input-event", () =>
    agentKeyDuringEvent.push(GuestKeys.isAgentKey(guest as unknown as Electron.WebContents)),
  );
  const guest = Object.assign(emitter, {
    isDestroyed: () => false,
    isCrashed: () => false,
    hostWebContents: null,
    setIgnoreMenuShortcuts: vi.fn(),
    sendInputEvent: (packet: GuestKeys.GuestKeyPacket) => {
      sent.push(packet);
      if (options.widget !== false && packet.type !== "char") {
        emitter.emit("before-input-event", {}, { type: packet.type, key: packet.keyCode });
      }
    },
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  });
  const commands: Array<string> = [];
  // The page's debugger: one frame, whose focus walk (`frameKeys.fork.ts`) finds
  // a field of its own, then event counts of 5, then a wait as `settled` says.
  const debuggee = {
    on: () => undefined,
    off: () => undefined,
    sendCommand: (method: string, params: Record<string, unknown> = {}) => {
      commands.push(method);
      if (method === "Target.getTargetInfo") {
        return Promise.resolve({ targetInfo: { targetId: "GUEST" } });
      }
      if (method === "Page.getFrameTree")
        return Promise.resolve({ frameTree: { frame: { id: "MAIN" } } });
      if (method === "Page.createIsolatedWorld") return Promise.resolve({ executionContextId: 1 });
      if (method !== "Runtime.evaluate") return Promise.resolve({});
      const expression = String(params["expression"]);
      expressions.push(expression);
      if (expression.includes("__t3KeyTarget = active")) {
        return Promise.resolve({
          result: { value: { frame: false, multiline: options.multiline ?? false } },
        });
      }
      if (expression.startsWith("new Promise")) {
        waiting();
        return (options.settled ?? Promise.resolve(true)).then((value) => ({ result: { value } }));
      }
      return Promise.resolve({ result: { value: { keyup: 5, keydown: 5, keypress: 5 } } });
    },
  };
  const tab = {
    webContents: guest as unknown as Electron.WebContents,
    debugger: debuggee as unknown as Electron.Debugger,
  };
  /** The main-path target the focus walk would hand `sendGuestKeys`. */
  const target = (multiline = options.multiline ?? false) => {
    const found = { session: undefined, contextId: 1, multiline };
    return { ...found, frame: FrameKeys.targetFrame(tab.debugger, found) };
  };
  return { tab, guest, sent, commands, agentKeyDuringEvent, expressions, settling, target };
};

/** Sends one CDP command on the page session and reads its reply. */
const roundTrip = (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  method: string,
  params: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const reader = yield* host.events.pipe(
      Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
      Stream.filter((event) => event.type === "cdp"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* host.handleCommandLine(
      encodeJson({
        type: "cdp",
        ...key,
        message: encodeJson({ id: 7, sessionId: "t3-preview-page", method, params }),
      }),
    );
    const [event] = yield* Fiber.join(reader);
    return decodeReply(event!.type === "cdp" ? event!.message : "");
  });

describe("guestKeys", () => {
  it.effect("sends an agent's key to the guest's own widget, never through CDP", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const tab = makeGuest();
      host.attach(key, tab.tab);
      const reply = yield* roundTrip(host, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "x",
        code: "KeyX",
        text: "x",
        windowsVirtualKeyCode: 88,
      });
      expect(reply.error).toBeUndefined();
      expect(tab.sent.map(({ type, keyCode }) => `${type}:${keyCode}`)).toEqual([
        "keyDown:x",
        "char:x",
      ]);
      expect(tab.commands.some((method) => method.startsWith("Input."))).toBe(false);
      // The preview manager leaves the key to the page, then sees human keys again.
      expect(tab.agentKeyDuringEvent).toEqual([true]);
      expect(GuestKeys.isAgentKey(tab.tab.webContents)).toBe(false);
      expect(tab.guest.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);

      yield* roundTrip(host, "Input.insertText", { text: "hi" });
      expect(tab.sent.slice(2).map(({ type, keyCode }) => `${type}:${keyCode}`)).toEqual([
        "char:h",
        "char:i",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves pointer and page commands on the debugger", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const tab = makeGuest();
      host.attach(key, tab.tab);
      yield* roundTrip(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });
      yield* roundTrip(host, "Runtime.evaluate", { expression: "1" });
      expect(tab.commands).toEqual(["Input.dispatchMouseEvent", "Runtime.evaluate"]);
      expect(tab.sent).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails a key the guest's widget does not take, and sends it nowhere else", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const tab = makeGuest({ widget: false });
      host.attach(key, tab.tab);
      const reply = yield* roundTrip(host, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        text: "\r",
      });
      expect(reply.error?.message).toMatch(/did not reach the preview page/);
      // The text never follows a key-down that did not land.
      expect(tab.sent.map(({ type }) => type)).toEqual(["keyDown"]);
      expect(tab.commands.some((method) => method.startsWith("Input."))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a composition rather than letting CDP retarget it", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const tab = makeGuest();
      host.attach(key, tab.tab);
      const reply = yield* roundTrip(host, "Input.imeSetComposition", { text: "x" });
      expect(reply.error?.message).toMatch(/does not support Input.imeSetComposition/);
      expect(tab.commands.some((method) => method.startsWith("Input."))).toBe(false);
      expect(tab.sent).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it("fails on a guest that is gone before sending anything", async () => {
    const tab = makeGuest();
    Object.assign(tab.guest, { isDestroyed: () => true });
    await expect(
      GuestKeys.sendGuestKeys(tab.tab.webContents, "Input.insertText", { text: "x" }, tab.target()),
    ).rejects.toThrow(/did not reach the preview page/);
    expect(tab.sent).toEqual([]);
  });

  it("replies only once the page has counted the keys it was sent", async () => {
    let settle: (value: boolean) => void = () => undefined;
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const tab = makeGuest({ settled });
    let replied = false;
    const reply = GuestKeys.sendGuestKeys(
      tab.tab.webContents,
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "x" },
      tab.target(),
    ).then(() => {
      replied = true;
    });
    // The counts are read before the key is sent, and the wait is for one more keyup.
    await tab.settling;
    expect(tab.expressions.at(-1)).toContain('get("keyup") ?? 0) >= 6');
    expect(tab.sent.map(({ type }) => type)).toEqual(["keyUp"]);
    expect(replied).toBe(false);
    settle(true);
    await reply;
    expect(replied).toBe(true);
  });

  it.effect("takes the line-break rule from the field the focus walk found", () =>
    Effect.gen(function* () {
      const typed = (multiline: boolean) =>
        Effect.gen(function* () {
          const host = yield* DesktopBrowserHost.make;
          const tab = makeGuest({ multiline });
          host.attach(key, tab.tab);
          const reply = yield* roundTrip(host, "Input.insertText", { text: "a\nb\r\nc\rd" });
          expect(reply.error).toBeUndefined();
          return tab.sent.map(({ keyCode }) => keyCode).join("");
        });
      // A "\n" char inserts nothing, so a textarea gets the Enter key's "\r".
      expect(yield* typed(true)).toBe("a\rb\rc\rd");
      // In a single-line field "\r" would submit its form, so breaks are dropped,
      // even while another frame holds a contenteditable body.
      expect(yield* typed(false)).toBe("abcd");
    }).pipe(Effect.scoped),
  );

  it("settles each command on the event its packets end with", () => {
    const settleOf = (method: string, params: Record<string, unknown>) =>
      GuestKeys.settleEvent(GuestKeys.guestKeyPackets(method, params));
    // A cancelled key-down drops its keypress, so a key-down waits for itself.
    expect(settleOf("Input.dispatchKeyEvent", { type: "keyDown", key: "x", text: "x" })).toEqual({
      type: "keydown",
      count: 1,
    });
    expect(settleOf("Input.dispatchKeyEvent", { type: "keyUp", key: "x" })).toEqual({
      type: "keyup",
      count: 1,
    });
    expect(settleOf("Input.insertText", { text: "abc" })).toEqual({ type: "keypress", count: 3 });
    expect(settleOf("Input.insertText", { text: "" })).toBeNull();
  });

  describe("guestKeyPackets", () => {
    const packets = (method: string, params: Record<string, unknown>) =>
      GuestKeys.guestKeyPackets(method, params).map(
        ({ type, keyCode, modifiers }) =>
          `${type}:${keyCode}${modifiers.length ? `+${modifiers.join("+")}` : ""}`,
      );

    it("keeps the key Playwright pressed", () => {
      for (const letter of ["x", "l", "a"]) {
        expect(
          packets("Input.dispatchKeyEvent", { type: "keyDown", key: letter, text: letter }),
        ).toEqual([`keyDown:${letter}`, `char:${letter}`]);
      }
      expect(packets("Input.dispatchKeyEvent", { type: "keyUp", key: "l", code: "KeyL" })).toEqual([
        "keyUp:l",
      ]);
    });

    it("names keys and modifiers as Electron does", () => {
      expect(
        packets("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", text: "\r" }),
      ).toEqual(["keyDown:Enter", "char:\r"]);
      expect(packets("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft" })).toEqual([
        "keyDown:Left",
      ]);
      expect(packets("Input.dispatchKeyEvent", { type: "keyDown", key: " ", text: " " })).toEqual([
        "keyDown:Space",
        "char: ",
      ]);
      expect(
        packets("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", modifiers: 2 }),
      ).toEqual(["keyDown:a+control"]);
      expect(
        packets("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F12", modifiers: 1 | 4 | 8 }),
      ).toEqual(["keyDown:F12+alt+meta+shift"]);
      expect(packets("Input.dispatchKeyEvent", { type: "keyUp", key: "Control" })).toEqual([
        "keyUp:Control",
      ]);
    });

    it("types text one code point at a time", () => {
      expect(packets("Input.insertText", { text: "é😀日" })).toEqual([
        "char:é",
        "char:😀",
        "char:日",
      ]);
      expect(packets("Input.insertText", { text: "" })).toEqual([]);
    });

    it("refuses a key Electron cannot name", () => {
      expect(() =>
        GuestKeys.guestKeyPackets("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "AudioVolumeUp",
        }),
      ).toThrow(/cannot press the key "AudioVolumeUp"/);
      expect(() =>
        GuestKeys.guestKeyPackets("Input.dispatchKeyEvent", { type: "keyDown", key: "" }),
      ).toThrow(GuestKeys.GuestKeyError);
    });
  });
});
