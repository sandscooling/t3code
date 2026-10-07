// @effect-diagnostics nodeBuiltinImport:off - Runs the app-window focus scripts against a stand-in DOM.
import { describe, expect, it } from "@effect/vitest";
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
