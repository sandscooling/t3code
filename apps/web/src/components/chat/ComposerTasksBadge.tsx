import { memo } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

export interface ComposerTasksProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export interface ComposerTaskStep {
  readonly durationMs?: number;
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

const MAX_TASK_SEGMENTS = 10;

function keyedTaskSteps(steps: readonly ComposerTaskStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });
}

/** The progress ticks beside the task count, one per step while they stay legible. */
export function ComposerTaskSegments({
  className,
  steps,
}: {
  readonly className?: string;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (steps.length <= 1 || steps.length > MAX_TASK_SEGMENTS) return null;

  return (
    <span aria-hidden className={cn("flex w-10 shrink-0 items-center gap-0.5", className)}>
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <span
          key={key}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.status === "completed"
              ? "bg-success"
              : step.status === "inProgress"
                ? "bg-primary"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

/** The expanded task list, rendered as the Tasks tab of the composer activity feed. */
export const ComposerTasksList = memo(function ComposerTasksList({
  progress,
  steps,
}: {
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <ComposerBanner.Children
      render={<ul role="list" />}
      aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
      data-composer-tasks-list="true"
    >
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <ComposerBanner.Row key={key} render={<li />}>
          <ComposerBanner.Icon
            className={cn(
              "font-mono text-[10px]",
              step.status === "completed"
                ? "text-success"
                : step.status === "inProgress"
                  ? "text-primary"
                  : "text-muted-foreground/40",
            )}
          >
            {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
          </ComposerBanner.Icon>
          <ComposerBanner.Content
            className={cn(
              step.status === "completed"
                ? "text-muted-foreground/55"
                : step.status === "inProgress"
                  ? "text-foreground/90"
                  : "text-muted-foreground/70",
            )}
          >
            {step.step}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <span
              className="w-10 text-right text-[10px] text-muted-foreground/45 tabular-nums"
              data-composer-task-duration="true"
            >
              {step.durationMs !== undefined
                ? formatDuration(step.durationMs)
                : step.status === "inProgress"
                  ? "now"
                  : null}
            </span>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      ))}
    </ComposerBanner.Children>
  );
});
