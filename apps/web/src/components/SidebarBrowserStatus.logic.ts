// Fork: what a sidebar row's globe shows.
import type { SidebarThreadSummary } from "../types";

export interface BrowserStatusIndicator {
  readonly label: "Agent using browser" | "Browser tab open";
  readonly colorClass: string;
  readonly pulse: boolean;
}

// Constants, so a row that re-renders keeps the same object.
const AGENT_USING_BROWSER: BrowserStatusIndicator = {
  label: "Agent using browser",
  colorClass: "text-sky-600 dark:text-sky-300/90",
  pulse: true,
};
const BROWSER_TAB_OPEN: BrowserStatusIndicator = {
  label: "Browser tab open",
  colorClass: "text-muted-foreground/40",
  pulse: false,
};

export type BrowserStatusThread = Pick<
  SidebarThreadSummary,
  "runtime" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/**
 * "Agent using browser" means the thread has a tab open while its turn is
 * working, the same condition as the sidebar's Working pill. Since upstream
 * moved the browser onto the server, no data every row already has says a
 * preview tool call is in flight, so this approximates it: a thread that
 * opened a tab and moved on to other work still lights up until its turn ends
 * or the tab closes.
 */
export function browserStatusIndicator(input: {
  readonly hasPreviewSession: boolean;
  readonly thread: BrowserStatusThread;
}): BrowserStatusIndicator | null {
  if (!input.hasPreviewSession) return null;
  const { thread } = input;
  const working =
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    (thread.runtime?.status === "running" || thread.runtime?.status === "waiting");
  return working ? AGENT_USING_BROWSER : BROWSER_TAB_OPEN;
}
