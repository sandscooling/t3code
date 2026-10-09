// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import * as NodeEvents from "node:events";

import * as FrameKeys from "./frameKeys.fork.ts";

/** What a frame's document reports as focused: a field, or a frame by its frame id. */
interface Focus {
  readonly frame?: string;
  readonly multiline?: boolean;
  /** The element the walk found has lost its frame's focus since. */
  readonly moved?: boolean;
}

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly session: string | undefined;
}

/**
 * A debugger over a page whose main frame is `MAIN`. `frames` maps each
 * frame's id to its focused element; `outOfProcess` lists the frames that are
 * targets of their own. It evaluates only in isolated worlds, so a walk that
 * read a page's own (patchable) world would fail here.
 */
const makeDebugger = (page: {
  readonly frames: Readonly<Record<string, Focus>>;
  readonly outOfProcess?: ReadonlyArray<string>;
}) => {
  const emitter = new NodeEvents.EventEmitter();
  const sent: Array<Sent> = [];
  const live = new Set<string>();
  const worlds = new Map<number, string>();
  let marked: string | undefined;
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string, params: Record<string, unknown> = {}, session?: string) => {
      sent.push({ method, params, session });
      if (session !== undefined && !live.has(session)) {
        return Promise.reject(new Error("No session with given id"));
      }
      switch (method) {
        case "Page.getFrameTree":
          return Promise.resolve({ frameTree: { frame: { id: "MAIN" } } });
        case "Page.createIsolatedWorld": {
          const frameId = params["frameId"] as string;
          if (!page.frames[frameId]) return Promise.reject(new Error("No frame"));
          worlds.set(worlds.size + 1, frameId);
          return Promise.resolve({ executionContextId: worlds.size });
        }
        case "Runtime.evaluate": {
          const frameId = worlds.get(params["contextId"] as number);
          if (frameId === undefined) return Promise.reject(new Error("Not an isolated world"));
          const focus = page.frames[frameId]!;
          const expression = String(params["expression"]);
          if (expression === FrameKeys.STILL_FOCUSED) {
            return Promise.resolve({ result: { value: !focus.moved } });
          }
          if (params["objectGroup"]) {
            marked = frameId;
            return Promise.resolve({ result: { objectId: `active-${frameId}` } });
          }
          return Promise.resolve({
            result: {
              value: { frame: focus.frame !== undefined, multiline: !!focus.multiline },
            },
          });
        }
        case "DOM.describeNode":
          return Promise.resolve({ node: { frameId: marked && page.frames[marked]!.frame } });
        case "Target.getTargetInfo":
          return (page.outOfProcess ?? []).includes(params["targetId"] as string)
            ? Promise.resolve({ targetInfo: { type: "iframe" } })
            : Promise.reject(new Error("No target with given id found"));
        default:
          return Promise.resolve({});
      }
    },
  });
  const tab = debuggee as unknown as Electron.Debugger;
  FrameKeys.trackFrameSessions(tab);
  return {
    tab,
    sent,
    attach: (targetId: string, sessionId: string, type = "iframe") => {
      live.add(sessionId);
      emitter.emit("message", {}, "Target.attachedToTarget", {
        sessionId,
        targetInfo: { targetId, type },
      });
    },
    detachSession: (sessionId: string) => {
      live.delete(sessionId);
      emitter.emit("message", {}, "Target.detachedFromTarget", { sessionId });
    },
    /** A session that died without the debugger saying so. */
    kill: (sessionId: string) => live.delete(sessionId),
    detachDebugger: () => emitter.emit("detach", {}, "target closed"),
  };
};

describe("findKeyTarget", () => {
  it("keeps keys on the main widget when the page's own field has focus", async () => {
    const page = makeDebugger({ frames: { MAIN: { multiline: true } } });
    expect(await FrameKeys.findKeyTarget(page.tab)).toMatchObject({
      session: undefined,
      multiline: true,
    });
  });

  it("follows focus into an out-of-process iframe, and through a nested one", async () => {
    const page = makeDebugger({
      frames: { MAIN: { frame: "CARD" }, CARD: { frame: "INNER" }, INNER: {} },
      outOfProcess: ["CARD", "INNER"],
    });
    page.attach("CARD", "S1");
    page.attach("INNER", "S2");
    expect(await FrameKeys.findKeyTarget(page.tab)).toMatchObject({
      session: "S2",
      multiline: false,
    });
    // Every frame is read from an isolated world (the fake has no other), and
    // every object the walk made is released in the session that made it.
    const released = page.sent.filter(({ method }) => method === "Runtime.releaseObjectGroup");
    expect(released.map(({ session }) => session)).toEqual([undefined, "S1"]);
    const worlds = page.sent.filter(({ method }) => method === "Page.createIsolatedWorld");
    expect(worlds.map(({ params, session }) => `${String(params["frameId"])}@${session}`)).toEqual([
      "MAIN@undefined",
      "CARD@S1",
      "INNER@S2",
    ]);
  });

  it("reads a same-process frame through its own world and stays on its widget", async () => {
    const page = makeDebugger({ frames: { MAIN: { frame: "LOCAL" }, LOCAL: { multiline: true } } });
    expect(await FrameKeys.findKeyTarget(page.tab)).toMatchObject({
      session: undefined,
      multiline: true,
    });
  });

  it("refuses a focused frame that runs apart but has no session", async () => {
    const page = makeDebugger({
      frames: { MAIN: { frame: "CARD" }, CARD: {} },
      outOfProcess: ["CARD"],
    });
    await expect(FrameKeys.findKeyTarget(page.tab)).rejects.toThrow(
      /runs apart and has no session/,
    );
    // A session that went away, or one that is not an iframe's, is not used either.
    page.attach("CARD", "S1");
    page.detachSession("S1");
    page.attach("CARD", "W1", "worker");
    await expect(FrameKeys.findKeyTarget(page.tab)).rejects.toThrow(/has no session/);
    page.attach("CARD", "S1");
    page.detachDebugger();
    await expect(FrameKeys.findKeyTarget(page.tab)).rejects.toThrow(/has no session/);
  });

  it("refuses when a frame cannot be read or the focused frame cannot be named", async () => {
    const unreadable = makeDebugger({
      frames: { MAIN: { frame: "CARD" }, CARD: {} },
      outOfProcess: ["CARD"],
    });
    unreadable.attach("CARD", "S1");
    unreadable.kill("S1");
    await expect(FrameKeys.findKeyTarget(unreadable.tab)).rejects.toThrow(/could not be read/);
    const unnamed = makeDebugger({ frames: { MAIN: { frame: "" } } });
    await expect(FrameKeys.findKeyTarget(unnamed.tab)).rejects.toThrow(/could not be identified/);
  });
});

describe("sendFrameKeys", () => {
  /** Walks to an iframe field, then sends one command to it. */
  const send = async (
    method: string,
    params: Record<string, unknown>,
    field: Focus = {},
  ): Promise<Array<Sent>> => {
    const page = makeDebugger({
      frames: { MAIN: { frame: "CARD" }, CARD: field },
      outOfProcess: ["CARD"],
    });
    page.attach("CARD", "S1");
    const target = await FrameKeys.findKeyTarget(page.tab);
    const guest = { setIgnoreMenuShortcuts: () => undefined } as unknown as Electron.WebContents;
    await FrameKeys.sendFrameKeys(guest, page.tab, { ...target, session: "S1" }, method, params);
    return page.sent.filter(({ method }) => method.startsWith("Input."));
  };

  it("sends the command on the iframe's session, never the page's", async () => {
    const params = { type: "keyDown", key: "x", text: "x" };
    expect(await send("Input.dispatchKeyEvent", params)).toEqual([
      { method: "Input.dispatchKeyEvent", params, session: "S1" },
    ]);
  });

  it("refuses to send once the field it found has lost its frame's focus", async () => {
    await expect(send("Input.insertText", { text: "x" }, { moved: true })).rejects.toThrow(
      /focus moved/,
    );
  });

  it("keeps line breaks in a multi-line editor and drops them from a single-line field", async () => {
    const text = (sent: Array<Sent>) => sent.map(({ params }) => params["text"]);
    expect(
      text(await send("Input.insertText", { text: "a\nb\r\nc" }, { multiline: true })),
    ).toEqual(["a\nb\nc"]);
    expect(text(await send("Input.insertText", { text: "a\nb\r\nc" }))).toEqual(["abc"]);
    expect(await send("Input.insertText", { text: "\n" })).toEqual([]);
  });

  it("refuses a composition", async () => {
    await expect(send("Input.imeSetComposition", { text: "x" })).rejects.toThrow(
      /does not support Input.imeSetComposition/,
    );
  });
});
