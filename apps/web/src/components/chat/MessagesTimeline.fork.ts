// Fork-owned: per-thread state for the latest turn's fold.
import type { RunId } from "@t3tools/contracts";
import { useState } from "react";

import type { TimelineLatestRun } from "./MessagesTimeline.logic";
import {
  citedCollapsedLatestRunId,
  latestCompletedRunId,
  toggledCollapsedLatestRunId,
} from "./MessagesTimeline.logic.fork";

// Keyed by thread so a collapse survives a thread switch; an entry goes stale harmlessly once a
// newer run is latest. Read only when the thread changes: the React Compiler caches render-time
// reads of module state on their inputs, so the rendered value lives in state.
const collapsedLatestRunIdByThread = new Map<string, RunId>();

/** The user's collapse of the latest completed turn's fold, for one thread. */
export function useCollapsedLatestTurnFold(
  threadKey: string,
  latestRun: TimelineLatestRun | null | undefined,
) {
  const [state, setState] = useState(() => ({
    threadKey,
    collapsedLatestRunId: collapsedLatestRunIdByThread.get(threadKey) ?? null,
  }));
  let collapsedLatestRunId = state.collapsedLatestRunId;
  if (state.threadKey !== threadKey) {
    collapsedLatestRunId = collapsedLatestRunIdByThread.get(threadKey) ?? null;
    setState({ threadKey, collapsedLatestRunId });
  }
  const latestCompleted = latestCompletedRunId(latestRun);

  // Applies a next value; `undefined` means the run is upstream's to handle.
  const apply = (next: RunId | null | undefined): boolean => {
    if (next === undefined) return false;
    if (next === collapsedLatestRunId) return true;
    if (next === null) collapsedLatestRunIdByThread.delete(threadKey);
    else collapsedLatestRunIdByThread.set(threadKey, next);
    setState({ threadKey, collapsedLatestRunId: next });
    return true;
  };

  /** Handles a fold click on the latest completed turn; false leaves it to upstream. */
  const toggleLatestTurnFold = (runId: RunId) =>
    apply(toggledCollapsedLatestRunId(collapsedLatestRunId, latestCompleted, runId));

  /** Opens the latest completed turn for a citation; false leaves it to upstream. */
  const openLatestTurnFold = (runId: RunId) =>
    apply(citedCollapsedLatestRunId(collapsedLatestRunId, latestCompleted, runId));

  return { collapsedLatestRunId, toggleLatestTurnFold, openLatestTurnFold };
}
