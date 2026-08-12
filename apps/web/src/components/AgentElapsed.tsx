/**
 * Elapsed time for a subagent's current activation, shared by the Agents
 * right panel and the composer activity bar so both read the same clock.
 *
 * Live rows self-tick via DOM writes (zero React commits per tick); settled
 * rows freeze at completedAt. The formatter stays exported because the
 * workflow summary rows render a frozen span rather than a ticking one.
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

export function AgentElapsed({
  agent,
  className,
}: {
  readonly agent: RuntimeSubagent;
  readonly className?: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isAgentTicking(agent.status);
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className={cn("tabular-nums", className)}>
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}
