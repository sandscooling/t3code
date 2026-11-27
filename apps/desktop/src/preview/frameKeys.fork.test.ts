import { describe, expect, it } from "@effect/vitest";

import * as FrameKeys from "./frameKeys.fork.ts";

/** What a frame's document reports as focused: a field, or a frame by its frame id. */
interface Focus {
  readonly frame?: string;
  readonly multiline?: boolean;
}

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly session: string | undefined;
}

/**
 * A debugger over a page whose main frame is `MAIN`. `frames` maps each frame's id to its focused
 * element; `outOfProcess` lists the frames that are targets of their own; `sessions` stands in for
 * the host's iframe sessions. It evaluates only in isolated worlds, so a walk that read a page's
 * own (patchable) world would fail here.
 */
const makeDebugger = (page: {
  readonly frames: Readonly<Record<string, Focus>>;
  readonly outOfProcess?: ReadonlyArray<string>;
}) => {
  const sessions = new Map<string, string>();
  const sent: Array<Sent> = [];
  const worlds = new Map<number, string>();
  let marked: string | undefined;
  const debuggee = {
    sendCommand: (method: string, params: Record<string, unknown> = {}, session?: string) => {
      sent.push({ method, params, session });
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
  };
  const tab = debuggee as unknown as Electron.Debugger;
  return {
    tab,
    sessions,
    sent,
    attach: (targetId: string, sessionId: string) => {
      sessions.set(targetId, sessionId);
    },
  };
};

describe("findKeyTarget", () => {
  it("keeps keys on the main widget when the page's own field has focus", async () => {
    const page = makeDebugger({ frames: { MAIN: { multiline: true } } });
    expect(await FrameKeys.findKeyTarget(page.tab, page.sessions)).toMatchObject({
      multiline: true,
    });
  });

  it("reads a same-process frame through its own world and stays on its widget", async () => {
    const page = makeDebugger({ frames: { MAIN: { frame: "LOCAL" }, LOCAL: { multiline: true } } });
    expect(await FrameKeys.findKeyTarget(page.tab, page.sessions)).toMatchObject({
      multiline: true,
    });
  });

  it("leaves focus in a cross-site frame to upstream's routing, and never reads inside it", async () => {
    const withSession = makeDebugger({
      frames: { MAIN: { frame: "CARD" }, CARD: { frame: "INNER" }, INNER: {} },
      outOfProcess: ["CARD", "INNER"],
    });
    withSession.attach("CARD", "S1");
    withSession.attach("INNER", "S2");
    expect(await FrameKeys.findKeyTarget(withSession.tab, withSession.sessions)).toBeNull();
    const withoutSession = makeDebugger({
      frames: { MAIN: { frame: "CARD" }, CARD: {} },
      outOfProcess: ["CARD"],
    });
    expect(await FrameKeys.findKeyTarget(withoutSession.tab, withoutSession.sessions)).toBeNull();
    for (const page of [withSession, withoutSession]) {
      // Every frame is read from an isolated world on the page's own session, and released there.
      expect(page.sent.every(({ session }) => session === undefined)).toBe(true);
      const worlds = page.sent.filter(({ method }) => method === "Page.createIsolatedWorld");
      expect(worlds.map(({ params }) => params["frameId"])).toEqual(["MAIN"]);
      expect(page.sent.some(({ method }) => method === "Runtime.releaseObjectGroup")).toBe(true);
    }
  });

  it("leaves a page it cannot read to upstream's routing", async () => {
    const unreadable = makeDebugger({ frames: { MAIN: { frame: "GONE" } } });
    expect(await FrameKeys.findKeyTarget(unreadable.tab, unreadable.sessions)).toBeNull();
    const unnamed = makeDebugger({ frames: { MAIN: { frame: "" } } });
    expect(await FrameKeys.findKeyTarget(unnamed.tab, unnamed.sessions)).toBeNull();
  });
});
