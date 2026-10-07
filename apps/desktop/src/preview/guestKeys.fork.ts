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

/** One char packet per code point, so text outside the BMP survives. */
const chars = (text: string, modifiers: ReadonlyArray<Modifier>): Array<GuestKeyPacket> =>
  [...text].map((keyCode) => ({ type: "char", keyCode, modifiers }));

/** The Electron packets that carry one DevTools key command to the guest's own widget. */
export const guestKeyPackets = (
  method: string,
  params: Record<string, unknown>,
): ReadonlyArray<GuestKeyPacket> => {
  if (method === "Input.insertText") return chars(stringParam(params, "text"), []);
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
 * Delivers one DevTools key command to `guest` alone. Every key-down and
 * key-up must pass the guest's own `before-input-event`, which Electron emits
 * synchronously inside `sendInputEvent`; one that does not fails the command.
 */
export const sendGuestKeys = async (
  guest: Electron.WebContents,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, never>> => {
  const packets = guestKeyPackets(method, params);
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
      const before = seen;
      sending = guest;
      try {
        guest.sendInputEvent(packet as Electron.KeyboardInputEvent);
      } finally {
        sending = null;
      }
      if (packet.type !== "char" && seen === before) throw new GuestKeyError(NOT_DELIVERED);
    }
  } finally {
    guest.off("before-input-event", count);
  }
  return {};
};
