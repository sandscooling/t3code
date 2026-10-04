/**
 * Fork-owned: following an orchestrator handoff. `session_spawn` with a handoff
 * sets the replaced thread's `successorThreadId`; the reader watching that
 * thread goes with it.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { buildThreadRouteParams } from "../threadRoutes";

/** The successor a viewed thread had when this reader first saw it. */
export interface HandoffFollowBaseline {
  readonly threadKey: string;
  readonly successorThreadId: ThreadId | null;
}

/**
 * The first snapshot of a thread is the baseline, however late it loads, so
 * reopening or reloading an old orchestrator stays put and only a succession
 * that arrives while the thread is open moves the reader.
 */
export function resolveHandoffFollow(
  baseline: HandoffFollowBaseline | null,
  threadKey: string,
  successorThreadId: ThreadId | null | undefined,
): { readonly baseline: HandoffFollowBaseline; readonly follow: ThreadId | null } {
  const successor = successorThreadId ?? null;
  if (baseline?.threadKey !== threadKey) {
    return { baseline: { threadKey, successorThreadId: successor }, follow: null };
  }
  if (successor === null || successor === baseline.successorThreadId) {
    return { baseline, follow: null };
  }
  return { baseline: { threadKey, successorThreadId: successor }, follow: successor };
}

/** Navigates the open thread view to its successor when the thread hands off. */
export function useHandoffFollow(
  threadShell: EnvironmentThreadShell | null,
  threadKey: string | null,
): void {
  const navigate = useNavigate();
  const successorThreadId = threadShell?.successorThreadId;
  const baselineRef = useRef<HandoffFollowBaseline | null>(null);
  useEffect(() => {
    if (threadShell === null || threadKey === null) return;
    const { baseline, follow } = resolveHandoffFollow(
      baselineRef.current,
      threadKey,
      successorThreadId,
    );
    baselineRef.current = baseline;
    if (follow === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadShell.environmentId, follow)),
    });
  }, [successorThreadId, threadKey, threadShell, navigate]);
}
