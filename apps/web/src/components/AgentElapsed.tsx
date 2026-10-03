/**
 * Fork: a clock counting up from a start time, for work that has no subagent
 * record to hand upstream's chat/AgentElapsed (the monitoring banner's
 * background tasks), plus the ticking rule the composer agents feed shares.
 *
 * The live clock self-ticks via DOM writes (zero React commits per tick).
 */
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

export function isAgentTicking(status: RuntimeSubagent["status"]): boolean {
  return status === "running" || status === "waiting";
}

/** A clock counting up from `startedAt`, ticking by DOM write once a second. */
export function LiveElapsed({
  startedAt,
  className,
}: {
  readonly startedAt: string;
  readonly className?: string | undefined;
}) {
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span ref={textRef} className={cn("tabular-nums", className)}>
      {elapsedBetween(startedAt, null)}
    </span>
  );
}
