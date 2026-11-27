// @effect-diagnostics globalTimers:off - Drives the input order with timers.
import { describe, expect, it, vi } from "@effect/vitest";

import * as GuestInput from "./guestInput.fork.ts";
import * as GuestKeys from "./guestKeys.fork.ts";

const GUEST_ID = 42;
const NO_FRAMES: ReadonlyMap<string, string> = new Map();

describe("routeGuestCommand", () => {
  const makeGuest = () => {
    const calls: Array<string> = [];
    const guest = { id: GUEST_ID } as unknown as Electron.WebContents;
    // A refused command never reads the debugger itself.
    const debuggee = {} as Electron.Debugger;
    return { guest, debuggee, calls };
  };

  it("refuses a raw message, which would carry a command past these checks", async () => {
    const { guest, debuggee, calls } = makeGuest();
    await expect(
      GuestInput.routeGuestCommand(
        guest,
        debuggee,
        NO_FRAMES,
        "Target.sendMessageToTarget",
        { message: '{"method":"Input.insertText"}' },
        () => {
          calls.push("forwarded");
          return Promise.resolve({});
        },
      ),
    ).rejects.toThrow(/Target.sendMessageToTarget/);
    expect(calls).toEqual([]);
  });
});

describe("routeGuestCommand keys", () => {
  /** A page whose focus is a field of its own, or an iframe `CARD` holding one. */
  const makePage = (focusInFrame: boolean) => {
    const sentKeys: Array<string> = [];
    const guest = {
      id: GUEST_ID,
      isDestroyed: () => false,
      isCrashed: () => false,
      setIgnoreMenuShortcuts: vi.fn(),
      prependListener: () => undefined,
      off: () => undefined,
      sendInputEvent: (packet: { readonly keyCode: string }) => sentKeys.push(packet.keyCode),
    } as unknown as Electron.WebContents;
    const debuggee = {
      sendCommand: (method: string, params: Record<string, unknown> = {}) => {
        if (method === "Page.getFrameTree") {
          return Promise.resolve({ frameTree: { frame: { id: "MAIN" } } });
        }
        if (method === "Page.createIsolatedWorld")
          return Promise.resolve({ executionContextId: 1 });
        if (method === "DOM.describeNode") return Promise.resolve({ node: { frameId: "CARD" } });
        if (method !== "Runtime.evaluate") return Promise.resolve({});
        if (params["objectGroup"]) return Promise.resolve({ result: { objectId: "card" } });
        const expression = String(params["expression"]);
        if (expression.includes("__t3KeyTarget = active")) {
          return Promise.resolve({ result: { value: { frame: focusInFrame, multiline: false } } });
        }
        if (expression.startsWith("new Promise"))
          return Promise.resolve({ result: { value: true } });
        return Promise.resolve({ result: { value: { keyup: 0, keydown: 0, keypress: 0 } } });
      },
    } as unknown as Electron.Debugger;
    return { guest, debuggee, sentKeys };
  };

  it("hands a key for a cross-site frame to upstream's routing once, as the agent's", async () => {
    const { guest, debuggee, sentKeys } = makePage(true);
    const markedDuringRoute: Array<boolean> = [];
    const result = await GuestInput.routeGuestCommand(
      guest,
      debuggee,
      new Map([["CARD", "S1"]]),
      "Input.insertText",
      { text: "4242" },
      async () => {
        await Promise.resolve();
        markedDuringRoute.push(GuestKeys.isAgentKey(guest));
        return "routed";
      },
    );
    expect(result).toBe("routed");
    expect(markedDuringRoute).toEqual([true]);
    expect(sentKeys).toEqual([]);
    expect(GuestKeys.isAgentKey(guest)).toBe(false);
    expect(guest.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
  });

  it("leaves a composition for a cross-site frame to upstream's routing, which takes it", async () => {
    const { guest, debuggee, sentKeys } = makePage(true);
    const forward = vi.fn(() => Promise.resolve("routed"));
    await expect(
      GuestInput.routeGuestCommand(
        guest,
        debuggee,
        new Map([["CARD", "S1"]]),
        "Input.imeSetComposition",
        { text: "か", selectionStart: 1, selectionEnd: 1 },
        forward,
      ),
    ).resolves.toBe("routed");
    expect(forward).toHaveBeenCalledOnce();
    expect(sentKeys).toEqual([]);
  });

  it("types into the page's own field on the guest's widget, never through upstream's path", async () => {
    const { guest, debuggee, sentKeys } = makePage(false);
    const forward = vi.fn(() => Promise.resolve({}));
    await GuestInput.routeGuestCommand(
      guest,
      debuggee,
      NO_FRAMES,
      "Input.insertText",
      { text: "ab" },
      forward,
    );
    expect(sentKeys).toEqual(["a", "b"]);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("routeGuestCommand input order", () => {
  /** A guest whose debugger records the mouse events it is sent. */
  const makeGuest = (debuggee = {} as Electron.Debugger) => {
    const guest = { id: GUEST_ID } as unknown as Electron.WebContents;
    const seen: Array<string> = [];
    const send = (type: string, forward = () => Promise.resolve<unknown>({})) =>
      GuestInput.routeGuestCommand(
        guest,
        debuggee,
        NO_FRAMES,
        "Input.dispatchMouseEvent",
        { type },
        () => {
          seen.push(type);
          return forward();
        },
      );
    return { guest, debuggee, seen, send };
  };

  it("sends the next command after a press that fails, which reaches its own caller", async () => {
    const { seen, send } = makeGuest();
    const pressed = send("mousePressed", () => Promise.reject(new Error("gone")));
    const released = send("mouseReleased");
    await expect(pressed).rejects.toThrow("gone");
    await released;
    expect(seen).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("sends the next command when a key before it never reaches the page", async () => {
    vi.useFakeTimers();
    try {
      // A page that never answers the key's focus walk.
      const hung = {
        sendCommand: () => new Promise(() => undefined),
      } as unknown as Electron.Debugger;
      const { guest, debuggee, seen, send } = makeGuest(hung);
      void GuestInput.routeGuestCommand(
        guest,
        debuggee,
        NO_FRAMES,
        "Input.insertText",
        { text: "a" },
        () => Promise.resolve({}),
      );
      const moved = send("mouseMoved");
      await vi.advanceTimersByTimeAsync(GuestInput.INPUT_HOLD_DEADLINE_MS - 1);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await moved;
      expect(seen).toEqual(["mouseMoved"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a key whose page answers only after the input behind it went", async () => {
    vi.useFakeTimers();
    try {
      // A page whose frame tree is read only once `answer` is called, as behind an alert().
      let answer = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const page = {
        sendCommand: async (method: string) => {
          if (method === "Page.getFrameTree") {
            await answered;
            return { frameTree: { frame: { id: "MAIN" } } };
          }
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          return { result: { value: { frame: false, multiline: false } } };
        },
      } as unknown as Electron.Debugger;
      const { guest, debuggee, seen, send } = makeGuest(page);
      Object.assign(guest, {
        isDestroyed: () => false,
        isCrashed: () => false,
        setIgnoreMenuShortcuts: () => undefined,
        prependListener: () => undefined,
        off: () => undefined,
        sendInputEvent: () => seen.push("key"),
      });
      const typed = GuestInput.routeGuestCommand(
        guest,
        debuggee,
        NO_FRAMES,
        "Input.insertText",
        { text: "a" },
        () => Promise.resolve({}),
      );
      const rejected = expect(typed).rejects.toThrow(/timed out waiting for the page/);
      const moved = send("mouseMoved");
      await vi.advanceTimersByTimeAsync(GuestInput.INPUT_HOLD_DEADLINE_MS);
      await moved;
      answer();
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      expect(seen).toEqual(["mouseMoved"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
