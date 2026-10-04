// Fork-owned: the latest finished turn shows its work; older turns fold.
import type { RunId } from "@t3tools/contracts";

import type { TimelineLatestRun } from "./MessagesTimeline.logic";

/**
 * The run whose fold opens by default: the thread's latest run, once it
 * completed. Interrupted, failed and still-running turns keep upstream's
 * handling, and a runless (imported) response never matches.
 */
export function latestCompletedRunId(latestRun: TimelineLatestRun | null | undefined) {
  return latestRun?.status === "completed" ? latestRun.runId : null;
}

/**
 * The latest completed turn is open unless the user collapsed it, which is
 * recorded apart from upstream's `expandedRunIds` ("opened"). A collapsed id
 * that is no longer the latest run does nothing, so it never needs cleanup.
 */
export function turnFoldExpanded(input: {
  readonly expandedRunIds: ReadonlySet<RunId> | undefined;
  readonly latestRun: TimelineLatestRun | null | undefined;
  readonly runId: RunId;
  readonly openLatestTurnFold: boolean | undefined;
  readonly collapsedLatestRunId: RunId | null | undefined;
}): boolean {
  return input.openLatestTurnFold === true && latestCompletedRunId(input.latestRun) === input.runId
    ? input.collapsedLatestRunId !== input.runId
    : (input.expandedRunIds?.has(input.runId) ?? false);
}

/**
 * The collapsed latest run id after the user clicks a turn's fold row, or
 * `undefined` when the turn is not the latest completed one and upstream's
 * `expandedRunIds` toggle applies.
 */
export function toggledCollapsedLatestRunId(
  collapsedLatestRunId: RunId | null,
  latestCompleted: RunId | null,
  runId: RunId,
): RunId | null | undefined {
  if (latestCompleted !== runId) return undefined;
  return collapsedLatestRunId === runId ? null : runId;
}

/**
 * The collapsed latest run id after a citation opens `runId`, or `undefined`
 * when the run is not the latest completed one and upstream adds it to
 * `expandedRunIds`. The latest completed run never joins that set, so a
 * later collapse of it cannot come back open once a newer run arrives.
 */
export function citedCollapsedLatestRunId(
  collapsedLatestRunId: RunId | null,
  latestCompleted: RunId | null,
  runId: RunId,
): RunId | null | undefined {
  if (latestCompleted !== runId) return undefined;
  return collapsedLatestRunId === runId ? null : collapsedLatestRunId;
}
