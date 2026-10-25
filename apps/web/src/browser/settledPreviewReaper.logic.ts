import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

/**
 * Which threads' preview sessions to close. An offscreen tab keeps its page's timers and sockets
 * running for as long as the session exists, so a settled thread's tab is pure waste. Settled is
 * the server-stamped flag the sidebar partitions on, so the settlement policy's exemptions
 * (running session, pending approval, keep-active pin) hold here for free.
 */

export interface ReapableThreadInput {
  /** Thread keys that currently hold at least one preview session. */
  readonly previewThreadKeys: ReadonlyArray<string>;
  readonly shellByThreadKey: ReadonlyMap<string, Pick<EnvironmentThreadShell, "settledOverride">>;
  /** Threads whose tab is presented on screen right now, never reaped. */
  readonly onScreenThreadKeys: ReadonlySet<string>;
}

export function selectReapableThreadKeys(input: ReapableThreadInput): ReadonlyArray<string> {
  return input.previewThreadKeys.filter((threadKey) => {
    // Never close the browser someone is looking at. A thread can settle while
    // it is open (the server's inactivity window elapses while you read), and
    // a tab vanishing mid-use is worse than the waste it saves.
    if (input.onScreenThreadKeys.has(threadKey)) {
      return false;
    }
    const shell = input.shellByThreadKey.get(threadKey);
    // A session whose thread is not loaded is unknown, not idle.
    if (!shell) {
      return false;
    }
    return shell.settledOverride === "settled";
  });
}
