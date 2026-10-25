// @effect-diagnostics globalTimers:off - Bounds Electron renderer calls, which run outside the Effect runtime.
/**
 * Fork: the one door between the server and a desktop tab's debugger. Keys go to the guest's own
 * widget or a focused out-of-process iframe's session; a pointer press returns focus to the app's
 * previous element (Chromium focuses the guest on a DevTools press) while the page keeps its own;
 * input keeps send order; `Target.sendMessageToTarget` is refused, as it would bypass these checks.
 */
import { findKeyTarget, sendFrameKeys, targetFrame } from "./frameKeys.fork.ts";
import { guestKeyPackets, isGuestKeyMethod, sendGuestKeys } from "./guestKeys.fork.ts";

export { trackFrameSessions } from "./frameKeys.fork.ts";

export class GuestInputError extends Error {
  override readonly name = "GuestInputError";
}

const isPointerPress = (method: string, params: Record<string, unknown>) =>
  (method === "Input.dispatchMouseEvent" && params["type"] === "mousePressed") ||
  (method === "Input.dispatchTouchEvent" && params["type"] === "touchStart");

/** Where the app's focus was before each guest's pending press, by guest id. */
const FOCUS_STORE = "__t3AgentPressFocus";

/**
 * Runs in the app's window: remembers its focused element for one guest's
 * press. A press that starts before the last one's restore (a double click)
 * keeps the element the first one remembered, which may already have lost
 * focus to the `<webview>`.
 */
export const rememberFocusExpression = (guestId: number) => `(() => {
  const store = (globalThis.${FOCUS_STORE} ??= new Map());
  const held = store.get(${guestId});
  if (held) held.presses += 1;
  else store.set(${guestId}, { element: document.activeElement, presses: 1 });
  return true;
})()`;

/**
 * Runs in the app's window after the press: undoes only a focus move onto this
 * guest's own `<webview>`, so focus the user already had in that page, or
 * moved elsewhere meanwhile, stays where it is. Only the last of overlapping
 * presses restores.
 */
export const restoreFocusExpression = (guestId: number) => `(() => {
  const store = globalThis.${FOCUS_STORE};
  const held = store?.get(${guestId});
  if (held && --held.presses > 0) return false;
  store?.delete(${guestId});
  const previous = held?.element;
  const active = document.activeElement;
  if (!active || active === previous || active.tagName !== "WEBVIEW") return false;
  if (typeof active.getWebContentsId !== "function" || active.getWebContentsId() !== ${guestId}) return false;
  if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
    previous.focus({ preventScroll: true });
  } else active.blur();
  return true;
})()`;

/** An app window that never answers must not hold up the agent's click. */
const APP_CALL_DEADLINE_MS = 2_000;

const inApp = (app: Electron.WebContents, expression: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, APP_CALL_DEADLINE_MS);
  });
  return Promise.race([
    app.executeJavaScript(expression).then(
      () => undefined,
      () => undefined,
    ),
    expired,
  ]).finally(() => clearTimeout(timer));
};

/** Runs one pointer press with the app's focus put back where the user had it. */
export const keepAppFocus = async <A>(
  guest: Electron.WebContents,
  press: () => Promise<A>,
): Promise<A> => {
  const app = guest.hostWebContents;
  if (!app || app.isDestroyed()) return press();
  await inApp(app, rememberFocusExpression(guest.id));
  try {
    return await press();
  } finally {
    if (!app.isDestroyed()) await inApp(app, restoreFocusExpression(guest.id));
  }
};

/** Sends a key command where the page's focus is: the main widget, or an iframe's session. */
const sendKeys = async (
  guest: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => {
  // An unsupported command is refused before the page is read.
  guestKeyPackets(method, params);
  const target = await findKeyTarget(debuggee);
  return target.session === undefined
    ? sendGuestKeys(
        guest,
        method,
        params,
        { ...target, frame: targetFrame(debuggee, target) },
        signal,
      )
    : sendFrameKeys(
        guest,
        debuggee,
        { ...target, session: target.session },
        method,
        params,
        signal,
      );
};

/**
 * Past this a queued command is dropped and the next one goes: one that never
 * reaches the guest must not hold the rest, nor land after them once it can.
 */
export const INPUT_HOLD_DEADLINE_MS = 10_000;

/** Each guest's newest queued input command, settled once it has gone to the guest. */
const inputTails = new WeakMap<Electron.WebContents, Promise<void>>();

/**
 * Runs `send` once every input command queued before it for `guest` has gone out: Playwright fires
 * a click's move, press and release at once, and a focus hop must not reorder them. `send` calls
 * `sent` once on the wire (all the next command waits for) and must check `signal`, aborted past
 * the deadline, right before sending. A failure reaches only its own caller.
 */
const inInputOrder = <A>(
  guest: Electron.WebContents,
  send: (sent: () => void, signal: AbortSignal) => Promise<A>,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let markSent = () => {};
  const sent = new Promise<void>((resolve) => {
    markSent = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const expiry = new AbortController();
  const previous = inputTails.get(guest) ?? Promise.resolve();
  inputTails.set(guest, sent);
  const result = previous.then(() => {
    timer = setTimeout(() => {
      expiry.abort(
        new GuestInputError(
          "The input was not sent: it timed out waiting for the page, so the input after it went first.",
        ),
      );
      markSent();
    }, INPUT_HOLD_DEADLINE_MS);
    return send(markSent, expiry.signal);
  });
  void result.then(markSent, markSent);
  return result;
};

/** Forwards, then marks the command sent: the debugger puts it on the wire inside the call. */
const forwardThen =
  (forward: () => Promise<unknown>, sent: () => void, signal: AbortSignal) => () => {
    try {
      signal.throwIfAborted();
      return forward();
    } finally {
      sent();
    }
  };

/** Routes one server command for `guest`; `forward` sends it to the guest's debugger. */
export const routeGuestCommand = (
  guest: Electron.WebContents,
  debuggee: Electron.Debugger,
  method: string,
  params: Record<string, unknown>,
  forward: () => Promise<unknown>,
): Promise<unknown> => {
  if (method === "Target.sendMessageToTarget") {
    return Promise.reject(
      new GuestInputError("Not supported for a desktop preview tab: Target.sendMessageToTarget"),
    );
  }
  if (isGuestKeyMethod(method)) {
    return inInputOrder(guest, (_sent, signal) =>
      sendKeys(guest, debuggee, method, params, signal),
    );
  }
  if (isPointerPress(method, params)) {
    return inInputOrder(guest, (sent, signal) =>
      keepAppFocus(guest, forwardThen(forward, sent, signal)),
    );
  }
  if (method.startsWith("Input.")) {
    return inInputOrder(guest, (sent, signal) => forwardThen(forward, sent, signal)());
  }
  return forward();
};
