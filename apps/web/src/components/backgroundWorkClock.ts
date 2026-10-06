import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { backgroundWorkTaskHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

/**
 * Fork: when the background work banner's clock starts, or null for no clock.
 * The banner clocks the newest task: the one the agent last started waiting on.
 */
export function backgroundWorkClockStartedAt(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): string | null {
  return newestTask(tasks)?.startedAt ?? null;
}

/**
 * Fork: what a sidebar row reading Waiting waits on, or null when nothing holds it.
 * Only tasks that hold completion count, so an unheld command started after a
 * subagent neither resets the clock nor changes the icon.
 */
export function sidebarWaitingOn(tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>): {
  readonly kind: "agent" | "command" | "pull-request";
  readonly startedAt: string | null;
} | null {
  const holding = tasks.filter(backgroundWorkTaskHoldsCompletion);
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
