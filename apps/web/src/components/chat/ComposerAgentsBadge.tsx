import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import { BotIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";

import { AgentElapsed, isAgentTicking } from "~/components/AgentElapsed";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

/**
 * The agents row of the composer activity banner.
 *
 * Subagents run past the moment their chat rows scroll away, and their only
 * other home is the Agents right panel, which is not visible while you type.
 * This is the same strip the task list uses, drawn with the same primitives:
 * one summary line for the agent that is leading, unfolding into one row per
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
function agentRows(model: AgentPanelModel): ReadonlyArray<{
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

function workingCount(model: AgentPanelModel): number {
  return model.runningCount + model.waitingCount;
}

function AgentsSummary({
  expanded,
  model,
}: {
  readonly expanded: boolean;
  readonly model: AgentPanelModel;
}) {
  const rows = agentRows(model);
  const lead = rows.find((row) => !isSettled(row.agent.status))?.agent ?? rows[0]?.agent ?? null;
  const working = workingCount(model);
  // The clock belongs to whichever agent is named on this line, so it only
  // renders while that one is ticking. Pinning it to a settled lead would put
  // a frozen number next to a live count and read as a stalled run.
  const leadIsTicking = lead !== null && isAgentTicking(lead.status);
  return (
    <>
      <ComposerBanner.Icon>
        <BotIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="shrink-0 text-muted-foreground">Agents</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            working > 0 ? "font-medium text-foreground/80" : "text-muted-foreground",
          )}
          data-composer-agent-lead="true"
        >
          {lead ? (lead.workflowName ?? lead.title) : "Agents"}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        {leadIsTicking ? (
          <AgentElapsed agent={lead} className="shrink-0 font-mono text-muted-foreground/80" />
        ) : null}
        <ComposerBanner.Count
          className={working === 0 ? "text-muted-foreground/60" : undefined}
          data-composer-agent-count="true"
        >
          {working > 0 ? `${working}/${rows.length}` : `${model.settledCount}`}
        </ComposerBanner.Count>
        <ComposerBanner.ToggleIcon expanded={expanded} />
      </ComposerBanner.Actions>
    </>
  );
}

export const ComposerAgentsBadge = memo(function ComposerAgentsBadge({
  expanded,
  model,
  onToggle,
  placement = "tab",
}: {
  readonly expanded: boolean;
  readonly model: AgentPanelModel;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
}) {
  if (!model.hasAgents) return null;

  const working = workingCount(model);
  const row = (
    <ComposerBanner.Row
      render={<button type="button" />}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse agents" : "Agents"}: ${working} working, ${model.settledCount} settled`}
      data-composer-agents-badge="true"
      onClick={onToggle}
      onPointerDown={(event) => event.preventDefault()}
    >
      <AgentsSummary expanded={expanded} model={model} />
    </ComposerBanner.Row>
  );
  return placement === "inline" ? (
    row
  ) : (
    <ComposerBanner.Root data-composer-shoulder-tab>{row}</ComposerBanner.Root>
  );
});

export const ComposerAgentsContent = memo(function ComposerAgentsContent({
  expanded,
  model,
  onOpenAgents,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly model: AgentPanelModel;
  readonly onOpenAgents: () => void;
  readonly onToggle: () => void;
}) {
  if (!model.hasAgents) return null;

  return (
    <div
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-agents-drawer={expanded ? "true" : undefined}
    >
      <ComposerAgentsBadge
        expanded={expanded}
        model={model}
        onToggle={onToggle}
        placement="inline"
      />
      {expanded ? (
        <ComposerBanner.Scroll data-composer-agents-scroll="true">
          <ComposerBanner.Children
            aria-label={`Agent list. ${workingCount(model)} working, ${model.settledCount} settled.`}
            data-composer-agents-list="true"
            role="list"
          >
            {agentRows(model).map(({ key, agent, group }) => {
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
                    <span className="min-w-0 flex-1 truncate">
                      {agent.workflowName ?? agent.title}
                    </span>
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
        </ComposerBanner.Scroll>
      ) : null}
    </div>
  );
});

export const ComposerAgentsDrawer = memo(function ComposerAgentsDrawer({
  onCollapse,
  ...props
}: Omit<ComponentProps<typeof ComposerAgentsContent>, "expanded" | "onToggle"> & {
  readonly onCollapse: () => void;
}) {
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root>
        <ComposerAgentsContent {...props} expanded onToggle={onCollapse} />
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
