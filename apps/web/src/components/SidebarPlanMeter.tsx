// Fork: the plan progress meter at the top of a sidebar row's hover card.
import { ListChecksIcon } from "lucide-react";

import type { SidebarThreadSummary } from "../types";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";

/**
 * Plan completion as a whole percentage, for the hover meter.
 *
 * Clamped rather than trusted: `planProgress` is an in-memory server snapshot
 * that can arrive mid-update, and a bar wider than its track is a worse way to
 * find that out than a bar pinned at 100.
 */
export function planProgressPercent(progress: {
  readonly completedSteps: number;
  readonly totalSteps: number;
}): number {
  if (progress.totalSteps <= 0) {
    return 0;
  }
  const ratio = progress.completedSteps / progress.totalSteps;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Whether a thread still has work in it, as opposed to being finished or idle.
 *
 * `resolveSidebarThreadStatus` collapses several live conditions into one
 * status and ranks them: a thread whose session is running reports "approval"
 * or "input" the moment it needs something from you. Anything that wants to
 * mean "still going" has to ask for the whole set, because testing for
 * "working" alone silently excludes a thread that is merely waiting on a
 * question.
 */
export function isSidebarThreadInFlight(status: SidebarThreadStatus): boolean {
  // v2's "waiting" (stopped with background work open) is v1's "monitoring".
  return (
    status === "working" || status === "waiting" || status === "approval" || status === "input"
  );
}

/**
 * Plan progress leads the hover card, gated on the thread being in flight at
 * all (approval and input outrank working, and a paused plan still wants its
 * step shown). The gate only guards a stale shell; the server clears
 * planProgress once no run is running.
 */
export function SidebarPlanMeter(props: { thread: SidebarThreadSummary }) {
  const progress = props.thread.planProgress;
  if (!progress || !isSidebarThreadInFlight(resolveSidebarThreadStatus(props.thread))) {
    return null;
  }
  const percent = planProgressPercent(progress);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ListChecksIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`Plan progress: ${progress.completedSteps} of ${progress.totalSteps} steps complete`}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="shrink-0 text-foreground/75 tabular-nums">{percent}%</span>
    </div>
  );
}
