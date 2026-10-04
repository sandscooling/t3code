// Fork-owned: per-thread state for the latest turn's fold.
import type { RunId } from "@t3tools/contracts";
import { useCallback, useReducer } from "react";

import type { TimelineLatestRun } from "./MessagesTimeline.logic";
import {
  citedCollapsedLatestRunId,
  latestCompletedRunId,
  toggledCollapsedLatestRunId,
} from "./MessagesTimeline.logic.fork";

// Keyed by the timeline's thread key, so a collapse survives a thread switch.
// An entry only exists while a thread's latest turn is collapsed, and it goes
// stale harmlessly once a newer run becomes the latest.
const collapsedLatestRunIdByThread = new Map<string, RunId>();

/**
 * The user's collapse of the latest completed turn's fold, for one thread.
 * The callbacks depend on the latest completed run id, not on `latestRun`,
 * which is a fresh object on every projection event.
 */
export function useCollapsedLatestTurnFold(
  threadKey: string,
  latestRun: TimelineLatestRun | null | undefined,
) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const latestCompleted = latestCompletedRunId(latestRun);
  const collapsedLatestRunId = collapsedLatestRunIdByThread.get(threadKey) ?? null;

  // Applies a next value; `undefined` means the run is upstream's to handle.
  const apply = useCallback(
    (next: RunId | null | undefined): boolean => {
      if (next === undefined) return false;
      if (next === (collapsedLatestRunIdByThread.get(threadKey) ?? null)) return true;
      if (next === null) collapsedLatestRunIdByThread.delete(threadKey);
      else collapsedLatestRunIdByThread.set(threadKey, next);
      rerender();
      return true;
    },
    [threadKey],
  );

  /** Handles a fold click on the latest completed turn; false leaves it to upstream. */
  const toggleLatestTurnFold = useCallback(
    (runId: RunId) =>
      apply(
        toggledCollapsedLatestRunId(
          collapsedLatestRunIdByThread.get(threadKey) ?? null,
          latestCompleted,
          runId,
        ),
      ),
    [apply, threadKey, latestCompleted],
  );

  /** Opens the latest completed turn for a citation; false leaves it to upstream. */
  const openLatestTurnFold = useCallback(
    (runId: RunId) =>
      apply(
        citedCollapsedLatestRunId(
          collapsedLatestRunIdByThread.get(threadKey) ?? null,
          latestCompleted,
          runId,
        ),
      ),
    [apply, threadKey, latestCompleted],
  );

  return { collapsedLatestRunId, toggleLatestTurnFold, openLatestTurnFold };
}
