import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { backgroundWorkTaskHoldsThread } from "@t3tools/shared/crewSession";

/**
 * Fork: what a sidebar row reading Waiting waits on, or null when nothing holds it.
 * Only tasks that hold the thread count, so an unheld command started after a
 * subagent neither resets the clock nor changes the icon (in a crew session
 * every command and monitor holds).
 */
export function sidebarWaitingOn(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  thread: Parameters<typeof backgroundWorkTaskHoldsThread>[0],
): {
  readonly kind: "agent" | "command" | "pull-request";
  readonly startedAt: string | null;
} | null {
  const holding = tasks.filter((task) => backgroundWorkTaskHoldsThread(thread, task));
  const task = newestTask(holding) ?? holding[0];
  if (task === undefined) {
    return null;
  }
  return {
    kind:
      task.kind === "subagent" ? "agent" : isPullRequestWatch(task) ? "pull-request" : "command",
    startedAt: task.startedAt ?? null,
  };
}

// A pull request watch is a monitor whose task id the shared code prefixes
// (pullRequestWatchTasks in orchestrationV2PendingBackgroundWork.ts).
function isPullRequestWatch(task: OrchestrationV2PendingBackgroundTask): boolean {
  return task.kind === "monitor" && task.taskId.startsWith("pull-request-watch:");
}

function newestTask(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): OrchestrationV2PendingBackgroundTask | undefined {
  let newest: OrchestrationV2PendingBackgroundTask | undefined;
  for (const task of tasks) {
    if (
      task.startedAt !== undefined &&
      (newest?.startedAt === undefined || Date.parse(task.startedAt) > Date.parse(newest.startedAt))
    ) {
      newest = task;
    }
  }
  return newest;
}
