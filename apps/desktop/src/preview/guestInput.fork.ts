// @effect-diagnostics globalTimers:off - Bounds Electron renderer calls, which run outside the Effect runtime.
/**
 * Fork: the one door between the server and a desktop tab's debugger, so the
 * agent's input stays in the page and the app's focus stays with the user.
 *
 * - Keys go to the guest's own widget (`guestKeys.fork.ts`), or, when the
 *   focused field is in an out-of-process iframe, to that iframe's own
 *   session (`frameKeys.fork.ts`).
 * - A pointer press gives the app its focus back. Chromium focuses the guest
 *   on a DevTools mouse press, so the app's `<webview>` element takes focus
 *   and the user's own typing goes into the page until they click back, even
 *   for a tab nobody shows (upstream #10980). Focusing the element the user
 *   had before returns keyboard focus to it, while the page keeps its own
 *   focused element, so the agent's later keys still land there (#13914
 *   measured the same on Windows).
 * - `Target.sendMessageToTarget` is refused: a raw message would carry a
 *   command past these checks.
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

/** Runs in the app's window: remembers its focused element for one guest's press. */
export const rememberFocusExpression = (guestId: number) =>
  `((globalThis.${FOCUS_STORE} ??= new Map()).set(${guestId}, document.activeElement), true)`;

/**
 * Runs in the app's window after the press: undoes only a focus move onto this
 * guest's own `<webview>`, so focus the user already had in that page, or
 * moved elsewhere meanwhile, stays where it is.
 */
export const restoreFocusExpression = (guestId: number) => `(() => {
  const store = globalThis.${FOCUS_STORE};
  const previous = store?.get(${guestId});
  store?.delete(${guestId});
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
) => {
  // An unsupported command is refused before the page is read.
  guestKeyPackets(method, params);
  const target = await findKeyTarget(debuggee);
  return target.session === undefined
    ? sendGuestKeys(guest, method, params, { ...target, frame: targetFrame(debuggee, target) })
    : sendFrameKeys(debuggee, { ...target, session: target.session }, method, params);
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
  if (isGuestKeyMethod(method)) return sendKeys(guest, debuggee, method, params);
  if (isPointerPress(method, params)) return keepAppFocus(guest, forward);
  return forward();
};
