import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../../session-logic";

/**
 * Plan progress anchored to the composer.
 *
 * The inline transcript chip anchors where planning began, so on a long turn it
 * scrolls out of view exactly when the plan is longest and the updates between
 * it and the bottom are densest. This pill holds still instead: collapsed it is
 * one line — segment bar, current step, n/m — and it unfolds upward into the
 * full list.
 *
 * Fed by deriveActivePlanState, which falls back to the most recent prior
 * turn's plan, so switching into a settled thread still shows where it landed.
 */
export function ComposerPlanPill({
  plan,
  expanded,
  onToggle,
}: {
  readonly plan: ActivePlanState;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { steps } = plan;
  if (steps.length === 0) {
    return null;
  }

  const completedCount = steps.filter((step) => step.status === "completed").length;
  const allDone = completedCount === steps.length;
  // Same label priority as the transcript chip: the in-progress step, else the
  // next pending one (a plan that was just written has no in-progress step
  // yet), else the last one — a finished plan, rendered muted.
  const label =
    steps.find((step) => step.status === "inProgress")?.step ??
    steps.find((step) => step.status === "pending")?.step ??
    steps.at(-1)?.step ??
    "Plan";
  const Chevron = expanded ? ChevronDownIcon : ChevronUpIcon;

  return (
    <div className={cn("mx-auto mb-2 w-full max-w-3xl", expanded ? null : "flex justify-center")}>
      <div
        className={cn(
          "min-w-0 overflow-hidden border border-border/60 bg-card/95 shadow-sm",
          expanded ? "w-full rounded-[18px]" : "w-fit max-w-full rounded-full",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`Plan progress: ${label}, ${completedCount} of ${steps.length} steps complete`}
          onClick={onToggle}
          className={cn(
            "flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs",
            "transition-colors duration-150 hover:bg-accent/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          )}
        >
          {steps.length > 1 ? (
            <span aria-hidden className="flex shrink-0 items-center gap-0.5">
              {steps.map((step) => (
                <span
                  key={step.step}
                  className={cn(
                    "h-[3px] w-2.5 rounded-full",
                    step.status === "completed"
                      ? "bg-success"
                      : step.status === "inProgress"
                        ? "bg-primary"
                        : "bg-muted-foreground/25",
                  )}
                />
              ))}
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate",
              allDone ? "text-muted-foreground" : "font-medium text-foreground",
            )}
          >
            {label}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {completedCount}/{steps.length}
          </span>
          <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        {expanded ? (
          <div className="max-h-[40vh] space-y-px overflow-y-auto border-t border-border/60 px-3 py-2">
            {steps.map((step) => (
              <div key={step.step} className="flex items-baseline gap-2 text-xs leading-5">
                <span
                  aria-hidden
                  className={cn(
                    "w-3 shrink-0 text-center font-mono text-[10px]",
                    step.status === "completed"
                      ? "text-success"
                      : step.status === "inProgress"
                        ? "text-primary"
                        : "text-muted-foreground/40",
                  )}
                >
                  {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
                </span>
                <span
                  className={cn(
                    "min-w-0",
                    step.status === "completed"
                      ? "text-muted-foreground/55"
                      : step.status === "inProgress"
                        ? "text-foreground/90"
                        : "text-muted-foreground/70",
                  )}
                >
                  {step.step}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
