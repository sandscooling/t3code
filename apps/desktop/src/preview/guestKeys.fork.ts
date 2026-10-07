// @effect-diagnostics globalTimers:off - Bounds Electron frame calls, which run outside the Effect runtime.
/**
 * Fork: an agent's keys reach a desktop tab's page and nothing else.
 *
 * Chromium's DevTools `Input.dispatchKeyEvent`, `Input.insertText` and
 * `Input.imeSetComposition` hand a main frame's keys to whichever widget has
 * focus in the outermost WebContents. A `<webview>` guest is an inner
 * WebContents, so while the user types in the app those keys land in the app,
 * such as the chat composer, whether or not the tab is shown. Upstream #11354
 * sent native packets instead; #15328 moved desktop tabs onto CDP through the
 * relay (`CdpRelay.ts`) and lost that.
 *
 * The relay hands those methods here and never to the debugger. Each becomes
 * Electron packets on the guest's own widget, which cannot be retargeted. A
 * key the guest's widget does not take fails the command, and with it the
 * agent's tool.
 */

/** The DevTools methods Chromium retargets to the app's focused widget. */
const GUEST_KEY_METHODS = new Set([
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.imeSetComposition",
]);

export const isGuestKeyMethod = (method: string) => GUEST_KEY_METHODS.has(method);

type Modifier = NonNullable<Electron.KeyboardInputEvent["modifiers"]>[number];

/**
 * No `skipIfUnhandled`: Electron then skips `before-input-event`, which is the
 * delivery check. A key the page leaves unhandled stops at the guest instead,
 * because `sendGuestKeys` sets it to ignore menu shortcuts.
 */
export interface GuestKeyPacket {
  readonly type: "keyDown" | "keyUp" | "char";
  readonly keyCode: string;
  readonly modifiers: ReadonlyArray<Modifier>;
}

/** DOM key names Electron's accelerator parser knows under the same name. */
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
]);

export class GuestKeyError extends Error {
  override readonly name = "GuestKeyError";
}

/** Electron's name for a DOM `key` value; anything it cannot name is refused. */
export const electronKeyCode = (key: string): string => {
  if (key === " ") return "Space";
  if (/^Arrow(?:Up|Down|Left|Right)$/u.test(key)) return key.slice("Arrow".length);
  if (NAMED_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key)) return key;
  if ([...key].length === 1) return key;
  throw new GuestKeyError(`A desktop preview tab cannot press the key "${key}".`);
};

const modifiersOf = (params: Record<string, unknown>): Array<Modifier> => {
  const mask = typeof params["modifiers"] === "number" ? params["modifiers"] : 0;
  const modifiers: Array<Modifier> = [];
  if (mask & 1) modifiers.push("alt");
  if (mask & 2) modifiers.push("control");
  if (mask & 4) modifiers.push("meta");
  if (mask & 8) modifiers.push("shift");
  if (params["isKeypad"] === true) modifiers.push("iskeypad");
  if (params["autoRepeat"] === true) modifiers.push("isautorepeat");
  return modifiers;
};

const stringParam = (params: Record<string, unknown>, name: string) =>
  typeof params[name] === "string" ? params[name] : "";

/** What the keys will land in, as the page reported it just before the send. */
export interface GuestKeyTarget {
  /** A textarea or contenteditable has focus, so a line break is text. */
  readonly multiline: boolean;
}

/** One char packet per code point, so text outside the BMP survives. */
const chars = (text: string, modifiers: ReadonlyArray<Modifier>): Array<GuestKeyPacket> =>
  [...text].map((keyCode) => ({ type: "char", keyCode, modifiers }));

/**
 * Inserted text's line breaks. A `"\n"` char inserts nothing, so a break goes
 * as `"\r"`, the Enter key's text, but only into a multi-line editor: in a
 * single-line field `"\r"` submits its form, so there breaks are dropped, as
 * the field's own value rules drop them. A pressed key keeps its text.
 */
export const insertedText = (text: string, target: GuestKeyTarget) =>
  text.replace(/\r\n|\r|\n/gu, target.multiline ? "\r" : "");

/** The Electron packets that carry one DevTools key command to the guest's own widget. */
export const guestKeyPackets = (
  method: string,
  params: Record<string, unknown>,
  target: GuestKeyTarget = { multiline: false },
): ReadonlyArray<GuestKeyPacket> => {
  if (method === "Input.insertText") {
    return chars(insertedText(stringParam(params, "text"), target), []);
  }
  if (method !== "Input.dispatchKeyEvent") {
    throw new GuestKeyError(`A desktop preview tab does not support ${method}.`);
  }
  const type = params["type"];
  const text = stringParam(params, "text");
  const modifiers = modifiersOf(params);
  if (type === "char") return chars(text, modifiers);
  const keyCode = electronKeyCode(stringParam(params, "key") || text);
  const key = { keyCode, modifiers };
  // Electron sends its `keyDown` as Chromium's raw key-down; the text follows as chars.
  if (type === "rawKeyDown") return [{ type: "keyDown", ...key }];
  if (type === "keyDown") return [{ type: "keyDown", ...key }, ...chars(text, modifiers)];
  if (type === "keyUp") return [{ type: "keyUp", ...key }];
  throw new GuestKeyError(`Unknown key event type: ${String(type)}.`);
};

/** The guest being handed an agent's key right now; `before-input-event` fires inside the send. */
let sending: Electron.WebContents | null = null;

/** True while `contents` is taking an agent's key, which belongs to the page and not to the app. */
export const isAgentKey = (contents: Electron.WebContents) => sending === contents;

const NOT_DELIVERED =
  "The key did not reach the preview page, so it was not sent anywhere else either.";

/**
 * The DOM event a command's packets end on, and how many of them, so the reply
 * can wait for the page to process them. A key-down's text may still be
 * queued then, but the key-up that follows it settles after it. A key-down
 * the page cancels drops its keypress, so only text alone settles on those.
 */
export const settleEvent = (
  packets: ReadonlyArray<GuestKeyPacket>,
): { readonly type: "keyup" | "keydown" | "keypress"; readonly count: number } | null => {
  const count = (type: GuestKeyPacket["type"]) =>
    packets.filter((packet) => packet.type === type).length;
  if (count("keyUp") > 0) return { type: "keyup", count: count("keyUp") };
  if (count("keyDown") > 0) return { type: "keydown", count: count("keyDown") };
  if (count("char") > 0) return { type: "keypress", count: count("char") };
  return null;
};

/** Past this the reply goes anyway: the keys reached the guest, only the wait is given up. */
export const SETTLE_DEADLINE_MS = 1_000;

/** Bounds a frame call that never answers, such as one behind a modal dialog. */
const within = <A>(work: Promise<A>, fallback: A): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SETTLE_DEADLINE_MS * 2);
  });
  return Promise.race([work.catch(() => fallback), expired]).finally(() => clearTimeout(timer));
};

/**
 * `performance.eventCounts` counts every dispatched event, whatever the page's
 * listeners do. A count read before the send and awaited after it means the
 * page has processed the keys. Electron has no input ack, and a CDP read
 * travels a different pipe than input, so it can overtake the keys. Both run
 * in the frame the focus walk found (`frameKeys.fork.ts`), in an isolated
 * world the page cannot patch.
 */
const COUNTS_EXPRESSION = `(() => {
  const counts = performance.eventCounts;
  if (!counts) return null;
  return {
    keyup: counts.get("keyup") ?? 0,
    keydown: counts.get("keydown") ?? 0,
    keypress: counts.get("keypress") ?? 0,
  };
})()`;

type EventCounts = Record<"keyup" | "keydown" | "keypress", number>;

/**
 * Resolves true once this frame has dispatched `target` events of `type`. The
 * listener runs inside the dispatch, so the count is checked one message
 * later, when the event's default action is done. A slow poll covers a page
 * listener that stops the event before this one sees it.
 */
const awaitEventCount = (type: string, target: number) => `new Promise((resolve) => {
  const counts = performance.eventCounts;
  const channel = new MessageChannel();
  let finished = false;
  const finish = (settled) => {
    if (finished) return;
    finished = true;
    removeEventListener(${JSON.stringify(type)}, later, true);
    clearInterval(poll);
    clearTimeout(deadline);
    channel.port1.close();
    resolve(settled);
  };
  const check = () => {
    if ((counts.get(${JSON.stringify(type)}) ?? 0) >= ${target}) finish(true);
  };
  const later = () => channel.port2.postMessage(0);
  channel.port1.onmessage = check;
  addEventListener(${JSON.stringify(type)}, later, true);
  const poll = setInterval(check, 50);
  const deadline = setTimeout(() => finish(false), ${SETTLE_DEADLINE_MS});
  check();
})`;

/** The frame that holds the page's focused element, as the focus walk found it. */
export interface MainKeyTarget extends GuestKeyTarget {
  readonly frame: { readonly executeJavaScript: (expression: string) => Promise<unknown> };
}

/**
 * Delivers one DevTools key command to `guest` alone, and replies once the
 * page has processed it, as Chromium's own reply does. `target` is where the
 * focus walk found the page's focused element. Every key-down and
 * key-up must pass the guest's own `before-input-event`, which Electron emits
 * synchronously inside `sendInputEvent`; one that does not fails the command.
 */
export const sendGuestKeys = async (
  guest: Electron.WebContents,
  method: string,
  params: Record<string, unknown>,
  target: MainKeyTarget,
): Promise<Record<string, never>> => {
  if (guest.isDestroyed() || guest.isCrashed()) throw new GuestKeyError(NOT_DELIVERED);
  const packets = guestKeyPackets(method, params, target);
  const settle = settleEvent(packets);
  const before = settle
    ? await within(
        target.frame.executeJavaScript(COUNTS_EXPRESSION) as Promise<EventCounts | null>,
        null,
      )
    : null;
  if (guest.isDestroyed() || guest.isCrashed()) throw new GuestKeyError(NOT_DELIVERED);
  // A human editing shortcut may have opened the menu path. An agent's key never
  // takes it, and an unhandled one stops here instead of reaching the window.
  guest.setIgnoreMenuShortcuts(true);
  let seen = 0;
  const count = () => {
    seen += 1;
  };
  guest.prependListener("before-input-event", count);
  try {
    for (const packet of packets) {
      const seenBefore = seen;
      sending = guest;
      try {
        guest.sendInputEvent(packet as Electron.KeyboardInputEvent);
      } finally {
        sending = null;
      }
      if (packet.type !== "char" && seen === seenBefore) throw new GuestKeyError(NOT_DELIVERED);
    }
  } finally {
    guest.off("before-input-event", count);
  }
  if (settle && before) {
    await within(
      target.frame.executeJavaScript(
        awaitEventCount(settle.type, before[settle.type] + settle.count),
      ),
      false,
    );
  }
  return {};
};
