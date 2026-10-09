// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Runs the app-window focus scripts against a stand-in DOM, and drives the input order with timers.
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeVM from "node:vm";

import * as GuestInput from "./guestInput.fork.ts";

const GUEST_ID = 42;

/** Just enough of the app's document for the focus scripts: elements, focus and blur. */
const makeAppWindow = () => {
  class HTMLElement {
    isConnected = true;
    readonly tagName: string;
    readonly name: string;
    constructor(tagName: string, name: string) {
      this.tagName = tagName;
      this.name = name;
    }
    focus() {
      document.activeElement = this;
    }
    blur() {
      if (document.activeElement === this) document.activeElement = document.body;
    }
  }
  class Webview extends HTMLElement {
    readonly id: number;
    constructor(name: string, id: number) {
      super("WEBVIEW", name);
      this.id = id;
    }
    getWebContentsId() {
      return this.id;
    }
  }
  const body = new HTMLElement("BODY", "body");
  const document = { body, activeElement: body as HTMLElement };
  const context = NodeVM.createContext({ document, HTMLElement });
  const run = (expression: string) => NodeVM.runInContext(expression, context) as boolean;
  return {
    document,
    composer: new HTMLElement("DIV", "composer"),
    webview: new Webview("webview", GUEST_ID),
    otherWebview: new Webview("other webview", GUEST_ID + 1),
    run,
    /** Remembers focus, lets `press` move it as Chromium would, then restores. */
    press: (move: () => void) => {
      run(GuestInput.rememberFocusExpression(GUEST_ID));
      move();
      return run(GuestInput.restoreFocusExpression(GUEST_ID));
    },
  };
};

describe("guestInput app focus", () => {
  it("gives the composer its focus back after an agent press takes it", () => {
    const app = makeAppWindow();
    app.composer.focus();
    expect(app.press(() => app.webview.focus())).toBe(true);
    expect(app.document.activeElement).toBe(app.composer);
  });

  it("blurs the webview when nothing in the app had focus", () => {
    const app = makeAppWindow();
    expect(app.press(() => app.webview.focus())).toBe(true);
    expect(app.document.activeElement).toBe(app.document.body);
  });

  it("blurs the webview when the element that had focus is gone", () => {
    const app = makeAppWindow();
    app.composer.focus();
    expect(
      app.press(() => {
        app.composer.isConnected = false;
        app.webview.focus();
      }),
    ).toBe(true);
    expect(app.document.activeElement).toBe(app.document.body);
  });

  it("leaves focus the user already had in that page", () => {
    const app = makeAppWindow();
    app.webview.focus();
    expect(app.press(() => app.webview.focus())).toBe(false);
    expect(app.document.activeElement).toBe(app.webview);
  });

  it("leaves focus the press did not move onto this guest", () => {
    const app = makeAppWindow();
    app.composer.focus();
    // The user clicked into another tab's page while the agent pressed.
    expect(app.press(() => app.otherWebview.focus())).toBe(false);
    expect(app.document.activeElement).toBe(app.otherWebview);
    // And a press that moved nothing changes nothing.
    app.composer.focus();
    expect(app.press(() => undefined)).toBe(false);
    expect(app.document.activeElement).toBe(app.composer);
  });

  it("restores once after overlapping presses, to the focus before the first", () => {
    const app = makeAppWindow();
    app.composer.focus();
    // A double click: the second press starts after the first took focus, before its restore.
    app.run(GuestInput.rememberFocusExpression(GUEST_ID));
    app.webview.focus();
    app.run(GuestInput.rememberFocusExpression(GUEST_ID));
    expect(app.run(GuestInput.restoreFocusExpression(GUEST_ID))).toBe(false);
    expect(app.document.activeElement).toBe(app.webview);
    expect(app.run(GuestInput.restoreFocusExpression(GUEST_ID))).toBe(true);
    expect(app.document.activeElement).toBe(app.composer);
  });
});

describe("routeGuestCommand", () => {
  /** A guest whose app window runs the focus scripts against `makeAppWindow`. */
  const makeGuest = () => {
    const calls: Array<string> = [];
    const appContents = {
      isDestroyed: () => false,
      executeJavaScript: (expression: string) => {
        calls.push(expression.includes(".set(") ? "remember" : "restore");
        return Promise.resolve(true);
      },
    };
    const guest = { id: GUEST_ID, hostWebContents: appContents } as unknown as Electron.WebContents;
    // Pointer and raw commands never read the debugger itself.
    const debuggee = {} as Electron.Debugger;
    return { guest, debuggee, calls };
  };

  it("wraps a pointer press in the app's focus, even when the press fails", async () => {
    const { guest, debuggee, calls } = makeGuest();
    const forwarded = await GuestInput.routeGuestCommand(
      guest,
      debuggee,
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 1, y: 1 },
      () => {
        calls.push("press");
        return Promise.resolve("sent");
      },
    );
    expect(forwarded).toBe("sent");
    await expect(
      GuestInput.routeGuestCommand(
        guest,
        debuggee,
        "Input.dispatchTouchEvent",
        { type: "touchStart" },
        () => {
          calls.push("press");
          return Promise.reject(new Error("gone"));
        },
      ),
    ).rejects.toThrow("gone");
    expect(calls).toEqual(["remember", "press", "restore", "remember", "press", "restore"]);
  });

  it("leaves other pointer events alone", async () => {
    const { guest, debuggee, calls } = makeGuest();
    for (const type of ["mouseMoved", "mouseReleased"]) {
      await GuestInput.routeGuestCommand(
        guest,
        debuggee,
        "Input.dispatchMouseEvent",
        { type },
        () => {
          calls.push("press");
          return Promise.resolve({});
        },
      );
    }
    expect(calls).toEqual(["press", "press"]);
  });

  it("refuses a raw message, which would carry a command past these checks", async () => {
    const { guest, debuggee, calls } = makeGuest();
    await expect(
      GuestInput.routeGuestCommand(
        guest,
        debuggee,
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

describe("routeGuestCommand input order", () => {
  /** Lets every queued promise reaction run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /**
   * A guest whose app window answers each focus script only when `answer` is
   * called, and whose debugger records the mouse events it is sent.
   */
  const makeGuest = (debuggee = {} as Electron.Debugger) => {
    const waiting: Array<{ readonly kind: string; readonly resolve: () => void }> = [];
    const appContents = {
      isDestroyed: () => false,
      executeJavaScript: (expression: string) =>
        new Promise<void>((resolve) => {
          waiting.push({ kind: expression.includes(".set(") ? "remember" : "restore", resolve });
        }),
    };
    const guest = { id: GUEST_ID, hostWebContents: appContents } as unknown as Electron.WebContents;
    const seen: Array<string> = [];
    const send = (type: string, forward = () => Promise.resolve<unknown>({})) =>
      GuestInput.routeGuestCommand(guest, debuggee, "Input.dispatchMouseEvent", { type }, () => {
        seen.push(type);
        return forward();
      });
    const answer = (kind: string) => {
      const index = waiting.findIndex((call) => call.kind === kind);
      waiting.splice(index, 1)[0]!.resolve();
    };
    return { guest, debuggee, seen, send, answer };
  };

  it("sends a release after its press, without waiting for the press's focus restore", async () => {
    const { seen, send, answer } = makeGuest();
    // Playwright's click: all three at once, relying on DevTools to keep their order.
    const moved = send("mouseMoved");
    const pressed = send("mousePressed");
    const released = send("mouseReleased");
    await moved;
    await settle();
    expect(seen).toEqual(["mouseMoved"]);
    answer("remember");
    await released;
    expect(seen).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    let pressDone = false;
    void pressed.then(() => {
      pressDone = true;
    });
    await settle();
    expect(pressDone).toBe(false);
    answer("restore");
    await pressed;
  });

  it("sends the next command after a press that fails, which reaches its own caller", async () => {
    const { seen, send, answer } = makeGuest();
    const pressed = send("mousePressed", () => Promise.reject(new Error("gone")));
    const released = send("mouseReleased");
    await settle();
    answer("remember");
    await settle();
    answer("restore");
    await expect(pressed).rejects.toThrow("gone");
    await released;
    expect(seen).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("sends a press and its release when the app window never answers", async () => {
    vi.useFakeTimers();
    try {
      const { seen, send } = makeGuest();
      const pressed = send("mousePressed");
      const released = send("mouseReleased");
      await vi.advanceTimersByTimeAsync(2_000);
      await released;
      expect(seen).toEqual(["mousePressed", "mouseReleased"]);
      await vi.advanceTimersByTimeAsync(2_000);
      await pressed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the next command when a key before it never reaches the page", async () => {
    vi.useFakeTimers();
    try {
      // A page that never answers the key's focus walk.
      const hung = {
        sendCommand: () => new Promise(() => undefined),
      } as unknown as Electron.Debugger;
      const { guest, debuggee, seen, send } = makeGuest(hung);
      void GuestInput.routeGuestCommand(guest, debuggee, "Input.insertText", { text: "a" }, () =>
        Promise.resolve({}),
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
