import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";

/**
 * Fork: when the background work banner's clock starts, or null for no clock.
 * The banner clocks the newest task: the one the agent last started waiting on.
 * The sidebar's Waiting duration reads the same start.
 */
export function backgroundWorkClockStartedAt(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): string | null {
  let newest: string | null = null;
  for (const task of tasks) {
    if (
      task.startedAt !== undefined &&
      (newest === null || Date.parse(task.startedAt) > Date.parse(newest))
    ) {
      newest = task.startedAt;
    }
  }
  return newest;
}
