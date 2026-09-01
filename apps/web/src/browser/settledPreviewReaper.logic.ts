import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Which threads should have their browser preview sessions closed.
 *
 * An offscreen preview tab is not parked the way an idle terminal is. The host
 * keeps every open session mounted for every thread, and
 * hostedBrowserWebviewStyle deliberately holds the guest CSS-visible while it
 * sits at -100000px so offscreen automation keeps working. That is the right
 * call for a thread an agent may still drive, and it means a settled thread's
 * tab goes on running the page's timers, fetches and sockets indefinitely.
 * A reactive app polling on a four-day-old thread is pure waste.
 *
 * Settled is read straight off the shell, which the server stamps. That is the
 * same flag the sidebar partitions on, so a tab is only reaped once its thread
 * has visibly moved out of the active list, and the exemptions the settlement
 * policy already applies (a running session, a pending approval, a keep-active
 * pin) hold here for free.
 */

export interface ReapableThreadInput {
  /** Thread keys that currently hold at least one preview session. */
  readonly previewThreadKeys: ReadonlyArray<string>;
  readonly shellByThreadKey: ReadonlyMap<string, OrchestrationThreadShell>;
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
