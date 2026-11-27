// @effect-diagnostics globalTimers:off - Bounds Electron renderer calls, which run outside the Effect runtime.
/**
 * Fork: the one door between the server and a desktop tab's debugger. Keys go to the guest's own
 * widget, or through upstream's routing to a focused cross-site frame; input keeps send order;
 * `Target.sendMessageToTarget` is refused, as it bypasses these.
 */
import { findKeyTarget, targetFrame } from "./frameKeys.fork.ts";
import { asAgentKeys, isGuestKeyMethod, sendGuestKeys } from "./guestKeys.fork.ts";

// @effect-diagnostics-next-line extendsNativeError:off - thrown back to Electron's debugger relay, outside Effect.
class GuestInputError extends Error {
  override readonly name = "GuestInputError";
}

/**
 * Sends a key command to the guest's own widget when its focused field is in the page's process;
 * any other focus goes to `forward`, upstream's routing into a cross-site frame
 * (pingdotgg/t3code#44012), still marked as the agent's key.
 */
const sendKeys = async (
  guest: Electron.WebContents,
  debuggee: Electron.Debugger,
  frameSessions: ReadonlyMap<string, string>,
  method: string,
  params: Record<string, unknown>,
  forward: () => Promise<unknown>,
  signal: AbortSignal,
) => {
  const target = await findKeyTarget(debuggee, frameSessions);
  if (target === null) {
    signal.throwIfAborted();
    return asAgentKeys(guest, forward);
  }
  return sendGuestKeys(
    guest,
    method,
    params,
    { ...target, frame: targetFrame(debuggee, target) },
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

/**
 * Routes one server command for `guest`; `forward` sends it to the guest's debugger.
 * `frameSessions` is the host's map of cross-site iframe sessions by frame id.
 */
export const routeGuestCommand = (
  guest: Electron.WebContents,
  debuggee: Electron.Debugger,
  frameSessions: ReadonlyMap<string, string>,
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
      sendKeys(guest, debuggee, frameSessions, method, params, forward, signal),
    );
  }
  if (method.startsWith("Input.")) {
    return inInputOrder(guest, (sent, signal) => forwardThen(forward, sent, signal)());
  }
  return forward();
};
