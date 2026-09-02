import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { memo } from "react";

import { AgentElapsed } from "~/components/AgentElapsed";
import { ComposerBanner } from "./ComposerBanner";

/**
 * The agents half of the composer activity feed.
 *
 * Subagents run past the moment their chat rows scroll away, and their only
 * other home is the Agents right panel, which is not visible while you type.
 * The feed above the composer carries them beside the task list, one row per
 * workflow or direct spawn.
 *
 * Depth stops at one row per item on purpose. AgentsPanel stays the only place
 * the full roster renders, so a workflow collapses to a single row here no
 * matter how many members it holds, and every row clicks through to the panel.
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

/** One row per workflow (they can hold dozens) and one per direct spawn. */
export function composerAgentRows(model: AgentPanelModel): ReadonlyArray<{
  readonly key: string;
  readonly agent: RuntimeSubagent;
  readonly group: AgentPanelWorkflowGroup | null;
}> {
  return [
    ...model.workflows.map((group) => ({ key: group.workflow.id, agent: group.workflow, group })),
    ...model.directAgents.map((agent) => ({ key: agent.id, agent, group: null })),
  ];
}

function workflowMemberCount(group: AgentPanelWorkflowGroup): number {
  return (
    group.phases.reduce((total, phase) => total + phase.members.length, 0) +
    group.unphasedMembers.length
  );
}

function isSettled(status: RuntimeSubagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/** The agent the summary line names: the first still in flight, else the first row. */
export function composerAgentLead(model: AgentPanelModel): RuntimeSubagent | null {
  const rows = composerAgentRows(model);
  return rows.find((row) => !isSettled(row.agent.status))?.agent ?? rows[0]?.agent ?? null;
}

export function composerAgentWorkingCount(model: AgentPanelModel): number {
  return model.runningCount + model.waitingCount;
}

// Settled outcomes only. In-flight rows used to read "Working", which the
// ticking clock beside them says better: it carries the same "this is live"
// signal and answers how long, which a static word never could.
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
    // Spawned but not started, so there is no clock to show yet: startedAt is
    // only stamped on the move to running. Queued rather than working, since
    // a fleet past the concurrency cap really is waiting its turn.
    case "pending":
      return "Queued";
    default:
      return null;
  }
}

/** The expanded agent roster, rendered as the Agents tab of the composer activity feed. */
export const ComposerAgentsList = memo(function ComposerAgentsList({
  model,
  onOpenAgents,
}: {
  readonly model: AgentPanelModel;
  readonly onOpenAgents: () => void;
}) {
  return (
    <ComposerBanner.Children
      aria-label={`Agent list. ${composerAgentWorkingCount(model)} working, ${model.settledCount} settled.`}
      data-composer-agents-list="true"
      role="list"
    >
      {composerAgentRows(model).map(({ key, agent, group }) => {
        const memberCount = group ? workflowMemberCount(group) : 0;
        const detail = group
          ? `${memberCount} agent${memberCount === 1 ? "" : "s"}`
          : (agent.progress ?? agent.lastToolName ?? statusText(agent.status));
        const tokens = agent.usage?.totalTokens ?? 0;
        return (
          <ComposerBanner.Row
            key={key}
            render={<button type="button" />}
            aria-label={`${agent.workflowName ?? agent.title}. Open the Agents panel.`}
            role="listitem"
            onClick={onOpenAgents}
          >
            <ComposerBanner.Icon>
              <ComposerBanner.Dot className={AGENT_STATUS_DOT[agent.status]} />
            </ComposerBanner.Icon>
            <ComposerBanner.Content className="text-foreground/90">
              <span className="min-w-0 flex-1 truncate">{agent.workflowName ?? agent.title}</span>
              {detail ? (
                <>
                  <ComposerBanner.Separator />
                  <span className="shrink-0 truncate text-muted-foreground/70">{detail}</span>
                </>
              ) : null}
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <AgentElapsed
                agent={agent}
                className="font-mono text-[10px] text-muted-foreground/60"
              />
              {tokens > 0 ? (
                <span className="text-[10px] text-muted-foreground/45 tabular-nums">
                  {formatSubagentTokenCount(tokens)} tok
                </span>
              ) : null}
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        );
      })}
    </ComposerBanner.Children>
  );
});
