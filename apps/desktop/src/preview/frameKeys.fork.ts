/**
 * Fork: an agent's keys reach a field in a cross-origin iframe, such as a Stripe card field. Chromium
 * gives an out-of-process iframe its own widget, so keys go as DevTools commands on the iframe's own
 * session, which Playwright's auto-attach already opens. The focus chain is walked from an isolated
 * world the page cannot patch; an out-of-process frame with no session fails the command.
 */
import { asAgentKey, GuestKeyError, insertedText } from "./guestKeys.fork.ts";

/** Each debugger's iframe sessions, by the iframe's target id (its frame id). */
const frameSessions = new WeakMap<Electron.Debugger, Map<string, string>>();

/** Follows `debuggee`'s iframe sessions; call once it is the tab's debugger. Idempotent. */
export const trackFrameSessions = (debuggee: Electron.Debugger) => {
  if (frameSessions.has(debuggee)) return;
  const sessions = new Map<string, string>();
  frameSessions.set(debuggee, sessions);
  debuggee.on("message", (_event, method, params) => {
    const event = params as {
      readonly sessionId?: string;
      readonly targetInfo?: { readonly targetId?: string; readonly type?: string };
    };
    if (method === "Target.attachedToTarget") {
      const targetId = event.targetInfo?.targetId;
      if (event.targetInfo?.type === "iframe" && targetId && event.sessionId) {
        sessions.set(targetId, event.sessionId);
      }
    } else if (method === "Target.detachedFromTarget") {
      for (const [targetId, sessionId] of sessions) {
        if (sessionId === event.sessionId) sessions.delete(targetId);
      }
    }
  });
  debuggee.on("detach", () => sessions.clear());
};

/**
 * Where the keys land: the main widget (no session) or an iframe's session,
 * and the isolated world of the frame that holds the focused element.
 */
export interface KeyTarget {
  readonly session: string | undefined;
  readonly contextId: number;
  readonly multiline: boolean;
}

/** Where the walk keeps the element it found, out of the page's reach. */
const MARK = "globalThis.__t3KeyTarget";
/**
 * This frame's focused element, through shadow roots. A frame stops it, even a
 * same-origin one: the walk steps into each frame by id, so the world it ends
 * in is the frame that holds the field, which is where the keys are counted.
 */
const ACTIVE = `(() => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
})()`;
/** Marks the focused element and says what it is. */
const DESCRIBE = `(() => {
  const active = ${ACTIVE};
  ${MARK} = active;
  return {
    frame: active?.tagName === "IFRAME" || active?.tagName === "FRAME",
    multiline: !!active && (active.tagName === "TEXTAREA" || active.isContentEditable === true),
  };
})()`;
/** True while the element the walk marked still has its frame's focus. */
export const STILL_FOCUSED = `(() => { const active = ${ACTIVE}; return active != null && active === ${MARK}; })()`;
const GROUP = "t3-frame-keys";
const WORLD = "t3-frame-keys";
/** Deeper than any real page nests its focused field. */
const MAX_DEPTH = 8;

type Send = (
  method: string,
  params: Record<string, unknown>,
  session: string | undefined,
) => Promise<unknown>;

const sender =
  (debuggee: Electron.Debugger): Send =>
  (method, params, session) =>
    session === undefined
      ? debuggee.sendCommand(method, params)
      : debuggee.sendCommand(method, params, session);

const unreachable = (why: string) =>
  new GuestKeyError(`The key was not sent: ${why}, so where it would land is unknown.`);

/** Evaluates in one frame's isolated world and answers its value; null when it could not. */
const evaluateIn = async (
  send: Send,
  session: string | undefined,
  contextId: number,
  expression: string,
): Promise<unknown> => {
  const evaluated = (await send(
    "Runtime.evaluate",
    { expression, contextId, returnByValue: true, awaitPromise: true },
    session,
  ).catch(() => null)) as { result?: { value?: unknown }; exceptionDetails?: unknown } | null;
  return evaluated && !evaluated.exceptionDetails ? (evaluated.result?.value ?? null) : null;
};

/** One frame's isolated world; the same name gives back the same world. */
const isolatedWorld = async (send: Send, session: string | undefined, frameId: string) => {
  const world = (await send(
    "Page.createIsolatedWorld",
    { frameId, worldName: WORLD },
    session,
  ).catch(() => null)) as { executionContextId?: number } | null;
  if (world?.executionContextId === undefined)
    throw unreachable("the focused frame could not be read");
  return world.executionContextId;
};

/** The frame id of the element the walk marked; it is a frame owner. */
const markedFrameId = (send: Send, session: string | undefined, contextId: number) =>
  send("Runtime.evaluate", { expression: MARK, contextId, objectGroup: GROUP }, session)
    .then(async (evaluated) => {
      const objectId = (evaluated as { result?: { objectId?: string } }).result?.objectId;
      if (!objectId) return undefined;
      const { node } = (await send("DOM.describeNode", { objectId }, session)) as {
        node?: { frameId?: string };
      };
      return node?.frameId;
    })
    .catch(() => undefined)
    .finally(() =>
      send("Runtime.releaseObjectGroup", { objectGroup: GROUP }, session).catch(() => undefined),
    );

/** Follows the page's focus to the frame whose widget takes the keys. */
export const findKeyTarget = async (debuggee: Electron.Debugger): Promise<KeyTarget> => {
  const sessions = frameSessions.get(debuggee) ?? new Map<string, string>();
  const send = sender(debuggee);
  const tree = (await send("Page.getFrameTree", {}, undefined).catch(() => null)) as {
    frameTree?: { frame?: { id?: string } };
  } | null;
  let frameId = tree?.frameTree?.frame?.id;
  if (!frameId) throw unreachable("the page's frame could not be read");
  let session: string | undefined;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const contextId = await isolatedWorld(send, session, frameId);
    const focus = (await evaluateIn(send, session, contextId, DESCRIBE)) as {
      frame: boolean;
      multiline: boolean;
    } | null;
    if (!focus) throw unreachable("the page's focus could not be read");
    if (!focus.frame) return { session, contextId, multiline: focus.multiline };
    const childFrameId = await markedFrameId(send, session, contextId);
    if (!childFrameId) throw unreachable("the focused frame could not be identified");
    // An iframe's session addresses its own frame, whose id is the target's.
    const child = sessions.get(childFrameId);
    if (child === undefined) {
      // No session: a frame in this one's process, unless it is a target of its own.
      const ownTarget = await send(
        "Target.getTargetInfo",
        { targetId: childFrameId },
        session,
      ).then(
        () => true,
        () => false,
      );
      if (ownTarget) throw unreachable("the focused frame runs apart and has no session");
    } else session = child;
    frameId = childFrameId;
  }
  throw unreachable("the page's frames nest too deep");
};

/** The target frame's isolated world, as the main path's settle wait reads it. */
export const targetFrame = (debuggee: Electron.Debugger, target: KeyTarget) => ({
  executeJavaScript: (expression: string) =>
    evaluateIn(sender(debuggee), target.session, target.contextId, expression),
});

/**
 * Sends one key command on an iframe's own session; Chromium replies after the frame processes it.
 * Line breaks follow the main path: kept in a multi-line editor, dropped where `"\r"` would submit.
 * A focus that moved off the walked element fails the command, and the key still passes `guest`'s
 * `before-input-event`, marked as the agent's.
 */
export const sendFrameKeys = async (
  guest: Electron.WebContents,
  debuggee: Electron.Debugger,
  target: KeyTarget & { readonly session: string },
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, never>> => {
  const send = sender(debuggee);
  let command: { readonly method: string; readonly params: Record<string, unknown> } | null;
  if (method === "Input.insertText") {
    const text = insertedText(typeof params["text"] === "string" ? params["text"] : "", target);
    command = text.length > 0 ? { method, params: { text: text.replaceAll("\r", "\n") } } : null;
  } else if (method === "Input.dispatchKeyEvent") {
    command = { method, params };
  } else {
    throw new GuestKeyError(`A desktop preview tab does not support ${method}.`);
  }
  if (command === null) return {};
  if ((await evaluateIn(send, target.session, target.contextId, STILL_FOCUSED)) !== true) {
    throw new GuestKeyError("The key was not sent: the frame's focus moved after it was found.");
  }
  // A key given up on while the frame was read must not land after the input sent since.
  signal?.throwIfAborted();
  await asAgentKey(guest, () => send(command.method, command.params, target.session));
  return {};
};
