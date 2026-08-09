import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import type { KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { BotIcon, ChevronDownIcon, ChevronUpIcon, ListTodoIcon, TerminalIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import type { ActivePlanState } from "../../session-logic";
import {
  activityBadgeTabs,
  availableActivityTabs,
  type ComposerActivitySources,
  type ComposerActivityTab,
  resolveActivityTab,
} from "./ComposerActivityBar.logic";

/**
 * Live thread activity anchored to the composer.
 *
 * The inline transcript chips anchor where work began, so on a long turn they
 * scroll out of view exactly when there is most to track. This bar holds still
 * instead: collapsed it is one line for whatever is live — the plan's current
 * step, the working subagents, the running shells — and it unfolds upward into
 * the full list, with tabs once more than one source has something to show.
 *
 * Depth stops at one row per item. The Agents right panel and the terminal
 * drawer own the real detail; rows here click through into them, which keeps
 * AgentsPanel the only place the full roster renders.
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

const TAB_LABEL: Record<ComposerActivityTab, string> = {
  tasks: "Tasks",
  agents: "Agents",
  shells: "Shells",
};

const TAB_ICON: Record<ComposerActivityTab, typeof BotIcon> = {
  tasks: ListTodoIcon,
  agents: BotIcon,
  shells: TerminalIcon,
};

interface ShellRow {
  readonly terminalId: string;
  readonly label: string;
  readonly detail: string;
  readonly dotClass: string;
  readonly live: boolean;
}

function shellRow(session: KnownTerminalSession): ShellRow {
  const { summary, status, hasRunningSubprocess } = session.state;
  const terminalId = session.target.terminalId;
  const label = resolveTerminalSessionLabel(terminalId, summary);
  if (status === "error") {
    return { terminalId, label, detail: "Error", dotClass: "bg-destructive", live: false };
  }
  if (status === "exited" || status === "closed") {
    const exitCode = summary?.exitCode ?? null;
    return {
      terminalId,
      label,
      detail: exitCode === null ? "Exited" : `Exited ${exitCode}`,
      dotClass: exitCode ? "bg-destructive" : "bg-muted-foreground/50",
      live: false,
    };
  }
  // The server-computed label already carries the running command, so the
  // detail column only has to say whether anything is running in there.
  return {
    terminalId,
    label,
    detail: hasRunningSubprocess ? "Running" : "Idle",
    dotClass: hasRunningSubprocess ? "bg-info" : "bg-muted-foreground/50",
    live: hasRunningSubprocess,
  };
}

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

function completedStepCount(plan: ActivePlanState): number {
  return plan.steps.filter((step) => step.status === "completed").length;
}

// Same label priority as the transcript chip: the in-progress step, else the
// next pending one (a plan that was just written has no in-progress step
// yet), else the last one — a finished plan, rendered muted.
function planLabel(plan: ActivePlanState): string {
  return (
    plan.steps.find((step) => step.status === "inProgress")?.step ??
    plan.steps.find((step) => step.status === "pending")?.step ??
    plan.steps.at(-1)?.step ??
    "Plan"
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

function statusText(status: RuntimeSubagent["status"]): string {
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
    default:
      return "Working";
  }
}

export function ComposerActivityBar({
  plan,
  agents,
  shells,
  expanded,
  storedTab,
  onToggle,
  onSelectTab,
  onOpenAgents,
  onOpenShell,
}: {
  readonly plan: ActivePlanState | null;
  readonly agents: AgentPanelModel;
  readonly shells: ReadonlyArray<KnownTerminalSession>;
  readonly expanded: boolean;
  readonly storedTab: ComposerActivityTab | null;
  readonly onToggle: () => void;
  readonly onSelectTab: (tab: ComposerActivityTab) => void;
  readonly onOpenAgents: () => void;
  readonly onOpenShell: (terminalId: string) => void;
}) {
  const rows = useMemo(() => shells.map(shellRow), [shells]);
  const sources: ComposerActivitySources = {
    tasks: {
      present: (plan?.steps.length ?? 0) > 0,
      liveCount: plan ? plan.steps.filter((step) => step.status !== "completed").length : 0,
    },
    agents: { present: agents.hasAgents, liveCount: agents.liveCount },
    shells: { present: rows.length > 0, liveCount: rows.filter((row) => row.live).length },
  };
  const tabs = availableActivityTabs(sources);
  const activeTab = resolveActivityTab(sources, storedTab);
  if (!activeTab) {
    return null;
  }
  const badges = activityBadgeTabs(sources, activeTab);
  const Chevron = expanded ? ChevronDownIcon : ChevronUpIcon;

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl">
      {/* Always composer-width, collapsed or not: a w-fit collapsed pill made
          the bar jump sideways on every toggle. The 18px radius clamps to a
          full pill at collapsed height, so the shape still reads as one. */}
      <div className="w-full min-w-0 overflow-hidden rounded-[18px] border border-border/60 bg-card/95 shadow-sm">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={summaryAriaLabel({ activeTab, plan, agents, rows, badges, sources })}
          onClick={onToggle}
          className={cn(
            "flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs",
            "transition-colors duration-150 hover:bg-accent/20",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          )}
        >
          {activeTab === "tasks" && plan ? <TasksSummary plan={plan} /> : null}
          {activeTab === "agents" ? <AgentsSummary model={agents} /> : null}
          {activeTab === "shells" ? <ShellsSummary rows={rows} /> : null}
          {/* Static chips, not buttons: nesting a control inside the toggle is
              invalid, and the tab row two pixels below is the real affordance. */}
          {badges.map((tab) => {
            const Icon = TAB_ICON[tab];
            return (
              <span
                key={tab}
                aria-hidden
                className="flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[.65rem] text-muted-foreground"
              >
                <Icon className="size-3" />
                <span className="tabular-nums">{sources[tab].liveCount}</span>
              </span>
            );
          })}
          <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
        {expanded ? (
          <div className="border-t border-border/60">
            {tabs.length > 1 ? (
              <div
                role="tablist"
                className="flex items-center gap-1 border-b border-border/50 px-2 py-1"
              >
                {tabs.map((tab) => {
                  const Icon = TAB_ICON[tab];
                  const selected = tab === activeTab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => onSelectTab(tab)}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 text-[.7rem] transition-colors",
                        selected
                          ? "bg-accent/60 font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/25 hover:text-foreground",
                      )}
                    >
                      <Icon aria-hidden className="size-3" />
                      {TAB_LABEL[tab]}
                      {sources[tab].liveCount > 0 ? (
                        <span className="tabular-nums text-muted-foreground">
                          {sources[tab].liveCount}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="max-h-[40vh] space-y-px overflow-y-auto px-3 py-2">
              {activeTab === "tasks" && plan ? <TasksList plan={plan} /> : null}
              {activeTab === "agents" ? (
                <AgentsList model={agents} onOpenAgents={onOpenAgents} />
              ) : null}
              {activeTab === "shells" ? <ShellsList rows={rows} onOpenShell={onOpenShell} /> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function summaryAriaLabel({
  activeTab,
  plan,
  agents,
  rows,
  badges,
  sources,
}: {
  readonly activeTab: ComposerActivityTab;
  readonly plan: ActivePlanState | null;
  readonly agents: AgentPanelModel;
  readonly rows: ReadonlyArray<ShellRow>;
  readonly badges: ReadonlyArray<ComposerActivityTab>;
  readonly sources: ComposerActivitySources;
}): string {
  const lead =
    activeTab === "tasks" && plan
      ? `Plan progress: ${planLabel(plan)}, ${completedStepCount(plan)} of ${plan.steps.length} steps complete`
      : activeTab === "agents"
        ? `Agents: ${agents.liveCount} working, ${agents.settledCount} settled`
        : `Shells: ${rows.filter((row) => row.live).length} running, ${rows.length} open`;
  const rest = badges
    .map((badge) => `${sources[badge].liveCount} ${TAB_LABEL[badge].toLowerCase()} active`)
    .join(", ");
  return rest.length > 0 ? `${lead}. Also ${rest}` : lead;
}

function TasksSummary({ plan }: { readonly plan: ActivePlanState }) {
  const { steps } = plan;
  const completedCount = completedStepCount(plan);
  const allDone = completedCount === steps.length;
  return (
    <>
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
          "min-w-0 flex-1 truncate",
          allDone ? "text-muted-foreground" : "font-medium text-foreground",
        )}
      >
        {planLabel(plan)}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {completedCount}/{steps.length}
      </span>
    </>
  );
}

function AgentsSummary({ model }: { readonly model: AgentPanelModel }) {
  const rows = agentRows(model);
  const lead = rows.find((row) => !isSettled(row.agent.status))?.agent ?? rows[0]?.agent ?? null;
  const working = model.runningCount + model.waitingCount;
  return (
    <>
      <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          working > 0 ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {lead ? (lead.workflowName ?? lead.title) : "Agents"}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {working > 0 ? `${working} working` : `${model.settledCount} settled`}
      </span>
    </>
  );
}

function ShellsSummary({ rows }: { readonly rows: ReadonlyArray<ShellRow> }) {
  const running = rows.filter((row) => row.live);
  const lead = running[0] ?? rows[0] ?? null;
  return (
    <>
      <TerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          running.length > 0 ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {lead?.label ?? "Shells"}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {running.length > 0 ? `${running.length} running` : `${rows.length} open`}
      </span>
    </>
  );
}

function TasksList({ plan }: { readonly plan: ActivePlanState }) {
  return (
    <>
      {plan.steps.map((step) => (
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
    </>
  );
}

function ActivityRow({
  dotClass,
  label,
  detail,
  trailing,
  onClick,
  title,
}: {
  readonly dotClass: string;
  readonly label: string;
  readonly detail: string | null;
  readonly trailing?: string | null;
  readonly onClick: () => void;
  readonly title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs leading-5",
        "transition-colors hover:bg-accent/30",
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      <span className="min-w-0 flex-1 truncate text-foreground/90">{label}</span>
      {detail ? (
        <span className="shrink-0 text-[.7rem] text-muted-foreground">{detail}</span>
      ) : null}
      {trailing ? (
        <span className="shrink-0 font-mono text-[.7rem] text-muted-foreground/80 tabular-nums">
          {trailing}
        </span>
      ) : null}
    </button>
  );
}

function AgentsList({
  model,
  onOpenAgents,
}: {
  readonly model: AgentPanelModel;
  readonly onOpenAgents: () => void;
}) {
  return (
    <>
      {agentRows(model).map(({ key, agent, group }) => {
        const memberCount = group ? workflowMemberCount(group) : 0;
        const detail = group
          ? `${memberCount} agent${memberCount === 1 ? "" : "s"}`
          : (agent.progress ?? agent.lastToolName ?? statusText(agent.status));
        const tokens = agent.usage?.totalTokens ?? 0;
        return (
          <ActivityRow
            key={key}
            dotClass={AGENT_STATUS_DOT[agent.status]}
            label={agent.workflowName ?? agent.title}
            detail={detail}
            trailing={tokens > 0 ? `${formatSubagentTokenCount(tokens)} tok` : null}
            onClick={onOpenAgents}
            title="Open the Agents panel"
          />
        );
      })}
    </>
  );
}

function ShellsList({
  rows,
  onOpenShell,
}: {
  readonly rows: ReadonlyArray<ShellRow>;
  readonly onOpenShell: (terminalId: string) => void;
}) {
  return (
    <>
      {rows.map((row) => (
        <ActivityRow
          key={row.terminalId}
          dotClass={row.dotClass}
          label={row.label}
          detail={row.detail}
          onClick={() => onOpenShell(row.terminalId)}
          title="Open this shell in the terminal drawer"
        />
      ))}
    </>
  );
}
