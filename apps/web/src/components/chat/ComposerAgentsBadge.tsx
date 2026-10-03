import {
  isTerminalSubagentStatus,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import type { ThreadId } from "@t3tools/contracts";
import { memo } from "react";

import { isAgentTicking } from "~/components/AgentElapsed";

import { AgentElapsed } from "./AgentElapsed";
import { ComposerBanner } from "./ComposerBanner";

/**
 * The agents half of the composer activity feed.
 *
 * Subagents run past the moment their chat rows scroll away, and nothing else
 * on screen tracks them while you type. The feed above the composer carries
 * the current turn's roster (v2's `deriveThreadTurnSubagents`) beside the task
 * list, one row per subagent. A row backed by its own thread opens that thread,
 * the same target upstream's background-work banner links to; provider-native
 * subagents have no other surface, so their rows are informational.
 */

const AGENT_STATUS_DOT: Record<RuntimeSubagent["status"], string> = {
  pending: "bg-info",
  running: "bg-info",
  waiting: "bg-info",
  idle: "bg-muted-foreground/50",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/60",
  interrupted: "bg-muted-foreground/60",
};

export interface ComposerAgentRow {
  readonly key: string;
  readonly agent: RuntimeSubagent;
  readonly childThreadId: ThreadId | null;
}

/** One row per subagent in the turn, in spawn order. */
export function composerAgentRows(model: ThreadTurnSubagents): ReadonlyArray<ComposerAgentRow> {
  const runtime = projectedSubagentsToRuntime(model.subagents);
  return model.subagents.map((subagent, index) => ({
    key: subagent.id,
    agent: runtime[index]!,
    childThreadId: subagent.childThreadId,
  }));
}

/** The agent the summary line names: the first still unsettled, else the first row. */
export function composerAgentLead(model: ThreadTurnSubagents): RuntimeSubagent | null {
  const rows = composerAgentRows(model);
  return (
    rows.find((row) => !isTerminalSubagentStatus(row.agent.status))?.agent ?? rows[0]?.agent ?? null
  );
}

export function composerAgentWorkingCount(model: ThreadTurnSubagents): number {
  return model.subagents.filter((subagent) => isAgentTicking(subagent.status)).length;
}

/** Unsettled agents: in flight, queued, or idle and resumable. */
export function composerAgentUnsettledCount(model: ThreadTurnSubagents): number {
  return model.subagents.length - model.settledCount;
}

// Settled outcomes only. In-flight rows show a ticking clock instead, which
// carries the same "this is live" signal and answers how long.
function statusText(status: RuntimeSubagent["status"]): string | null {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "idle":
      return "Idle";
    // Spawned but not started, so there is no clock to show yet.
    case "pending":
      return "Queued";
    default:
      return null;
  }
}

/** The expanded agent roster, rendered as the Agents tab of the composer activity feed. */
export const ComposerAgentsList = memo(function ComposerAgentsList({
  model,
  onOpenAgentThread,
}: {
  readonly model: ThreadTurnSubagents;
  readonly onOpenAgentThread: (threadId: ThreadId) => void;
}) {
  return (
    <ComposerBanner.Children
      aria-label={`Agent list. ${composerAgentWorkingCount(model)} working, ${model.settledCount} settled.`}
      data-composer-agents-list="true"
      role="list"
    >
      {composerAgentRows(model).map(({ key, agent, childThreadId }) => {
        const detail = agent.progress ?? statusText(agent.status);
        return (
          <ComposerBanner.Row
            key={key}
            role="listitem"
            {...(childThreadId === null
              ? { "aria-label": agent.title }
              : {
                  render: <button type="button" />,
                  "aria-label": `${agent.title}. Open the agent's thread.`,
                  onClick: () => onOpenAgentThread(childThreadId),
                })}
          >
            <ComposerBanner.Icon>
              <ComposerBanner.Dot className={AGENT_STATUS_DOT[agent.status]} />
            </ComposerBanner.Icon>
            <ComposerBanner.Content className="text-foreground/90">
              <span className="min-w-0 flex-1 truncate">{agent.title}</span>
              {detail ? (
                <>
                  <ComposerBanner.Separator />
                  <span className="shrink-0 truncate text-muted-foreground/70">{detail}</span>
                </>
              ) : null}
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <span className="font-mono text-3xs text-muted-foreground/60">
                <AgentElapsed agent={agent} />
              </span>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        );
      })}
    </ComposerBanner.Children>
  );
});
