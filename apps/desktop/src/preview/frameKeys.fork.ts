/**
 * Fork: finds where an agent's keys land when the page's own process holds the focused field,
 * through shadow roots and same-process frames, read from an isolated world the page cannot patch.
 * Focus in a cross-site frame, or a page this cannot read, is left to upstream's routing
 * (`routeKeysToFrame` in `GuestInput.ts`, pingdotgg/t3code#44012).
 */

/** The isolated world of the frame that holds the focused element, on the guest's own widget. */
interface KeyTarget {
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
const GROUP = "t3-frame-keys";
const WORLD = "t3-frame-keys";
/** Deeper than any real page nests its focused field. */
const MAX_DEPTH = 8;

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const sender =
  (debuggee: Electron.Debugger): Send =>
  (method, params) =>
    debuggee.sendCommand(method, params);

/** Evaluates in one frame's isolated world and answers its value; null when it could not. */
const evaluateIn = async (send: Send, contextId: number, expression: string): Promise<unknown> => {
  const evaluated = (await send("Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  }).catch(() => null)) as { result?: { value?: unknown }; exceptionDetails?: unknown } | null;
  return evaluated && !evaluated.exceptionDetails ? (evaluated.result?.value ?? null) : null;
};

/** One frame's isolated world; the same name gives back the same world. */
const isolatedWorld = async (send: Send, frameId: string) => {
  const world = (await send("Page.createIsolatedWorld", { frameId, worldName: WORLD }).catch(
    () => null,
  )) as { executionContextId?: number } | null;
  return world?.executionContextId;
};

/** The frame id of the element the walk marked; it is a frame owner. */
const markedFrameId = (send: Send, contextId: number) =>
  send("Runtime.evaluate", { expression: MARK, contextId, objectGroup: GROUP })
    .then(async (evaluated) => {
      const objectId = (evaluated as { result?: { objectId?: string } }).result?.objectId;
      if (!objectId) return undefined;
      const { node } = (await send("DOM.describeNode", { objectId })) as {
        node?: { frameId?: string };
      };
      return node?.frameId;
    })
    .catch(() => undefined)
    .finally(() =>
      send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined),
    );

/**
 * Follows the page's focus to the field the guest's own widget takes keys for; null when the focus
 * is in a cross-site frame (one with an iframe session in `sessions`, or a target of its own) or
 * cannot be read, which upstream's key routing then handles.
 */
export const findKeyTarget = async (
  debuggee: Electron.Debugger,
  sessions: ReadonlyMap<string, string>,
): Promise<KeyTarget | null> => {
  const send = sender(debuggee);
  const tree = (await send("Page.getFrameTree", {}).catch(() => null)) as {
    frameTree?: { frame?: { id?: string } };
  } | null;
  let frameId = tree?.frameTree?.frame?.id;
  if (!frameId) return null;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const contextId = await isolatedWorld(send, frameId);
    if (contextId === undefined) return null;
    const focus = (await evaluateIn(send, contextId, DESCRIBE)) as {
      frame: boolean;
      multiline: boolean;
    } | null;
    if (!focus) return null;
    if (!focus.frame) return { contextId, multiline: focus.multiline };
    const childFrameId = await markedFrameId(send, contextId);
    if (!childFrameId || sessions.has(childFrameId)) return null;
    // No session: a frame in this one's process, unless it is a target of its own.
    const ownTarget = await send("Target.getTargetInfo", { targetId: childFrameId }).then(
      () => true,
      () => false,
    );
    if (ownTarget) return null;
    frameId = childFrameId;
  }
  return null;
};

/** The target frame's isolated world, as the main path's settle wait reads it. */
export const targetFrame = (debuggee: Electron.Debugger, target: KeyTarget) => ({
  executeJavaScript: (expression: string) =>
    evaluateIn(sender(debuggee), target.contextId, expression),
});
