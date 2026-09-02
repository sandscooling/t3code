import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { BotIcon, ListTodoIcon } from "lucide-react";
import { memo, useId, type ComponentProps } from "react";

import { AgentElapsed, isAgentTicking } from "~/components/AgentElapsed";
import { cn } from "~/lib/utils";
import {
  ComposerAgentsList,
  composerAgentLead,
  composerAgentRows,
  composerAgentWorkingCount,
} from "./ComposerAgentsBadge";
import { ComposerBanner } from "./ComposerBanner";
import {
  ComposerTaskSegments,
  ComposerTasksList,
  type ComposerTasksProgress,
  type ComposerTaskStep,
} from "./ComposerTasksBadge";

/**
 * The activity feed above the composer: one row, whatever is running.
 *
 * Tasks and agents are separate feeds, but they are the same kind of thing to
 * the reader (work in flight that outlives the chat rows that started it), and
 * a row each pushed the composer down for no gain. They share a summary line
 * here and split into tabs once the drawer is open, so the strip costs one row
 * no matter how many feeds are live.
 */

export type ComposerActivityTab = "tasks" | "agents";

export interface ComposerActivityTasks {
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}

export interface ComposerActivityFeeds {
  readonly agents: AgentPanelModel | null;
  readonly tasks: ComposerActivityTasks | null;
}

/**
 * Whether either feed still has work in flight, and so is worth a row.
 *
 * A task list drops out on its own once every step is done, so a live one is
 * always worth showing. Agents linger after they settle, which left a finished
 * roster holding a row above the composer with nothing left to report. The
 * strip keeps that row only while an agent is unsettled.
 */
export function hasLiveComposerActivity({ agents, tasks }: ComposerActivityFeeds): boolean {
  if (tasks !== null) return true;
  return agents !== null && agents.liveCount + agents.idleCount > 0;
}

/** The tab actually shown: a requested tab whose feed went away falls back to the other. */
export function resolveComposerActivityTab(
  requested: ComposerActivityTab,
  { agents, tasks }: ComposerActivityFeeds,
): ComposerActivityTab | null {
  if (tasks === null) return agents === null ? null : "agents";
  if (agents === null) return "tasks";
  return requested;
}

function agentCountLabel(model: AgentPanelModel): string {
  const working = composerAgentWorkingCount(model);
  return working > 0 ? `${working}/${composerAgentRows(model).length}` : `${model.settledCount}`;
}

// Tasks lead the summary when both feeds are live: they carry the turn the user
// is watching, while agents are the thing running underneath it.
function ActivitySummary({
  agents,
  expanded,
  tasks,
}: ComposerActivityFeeds & { readonly expanded: boolean }) {
  const lead = agents ? composerAgentLead(agents) : null;
  // The clock belongs to whichever agent is named on this line, so it only
  // renders while that one is ticking and while it is the one being named.
  const showLeadClock = tasks === null && lead !== null && isAgentTicking(lead.status);
  const working = agents ? composerAgentWorkingCount(agents) : 0;
  return (
    <>
      <ComposerBanner.Icon>{tasks ? <ListTodoIcon /> : <BotIcon />}</ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="shrink-0 text-muted-foreground">{tasks ? "Tasks" : "Agents"}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            tasks || working > 0 ? "font-medium text-foreground/80" : "text-muted-foreground",
          )}
          data-composer-activity-headline="true"
        >
          {tasks ? tasks.progress.step : (lead?.workflowName ?? lead?.title ?? "Agents")}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        {showLeadClock && lead ? (
          <AgentElapsed agent={lead} className="shrink-0 font-mono text-muted-foreground/80" />
        ) : null}
        {tasks ? (
          <>
            <ComposerBanner.Count
              className={
                tasks.progress.completedSteps >= tasks.progress.totalSteps
                  ? "text-success"
                  : undefined
              }
              data-composer-task-progress="true"
            >
              {tasks.progress.completedSteps}/{tasks.progress.totalSteps}
            </ComposerBanner.Count>
            <ComposerTaskSegments className="hidden w-20 sm:flex" steps={tasks.steps} />
          </>
        ) : null}
        {agents ? (
          <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
            {tasks ? <BotIcon aria-hidden className="size-3" /> : null}
            <ComposerBanner.Count
              className={working === 0 ? "text-muted-foreground/60" : undefined}
              data-composer-agent-count="true"
            >
              {agentCountLabel(agents)}
            </ComposerBanner.Count>
          </span>
        ) : null}
        <ComposerBanner.ToggleIcon expanded={expanded} />
      </ComposerBanner.Actions>
    </>
  );
}

function summaryLabel({ agents, tasks }: ComposerActivityFeeds): string {
  const parts: string[] = [];
  if (tasks) {
    parts.push(
      `${tasks.progress.completedSteps} of ${tasks.progress.totalSteps} tasks complete, current task ${tasks.progress.step}`,
    );
  }
  if (agents) {
    parts.push(
      `${composerAgentWorkingCount(agents)} agents working, ${agents.settledCount} settled`,
    );
  }
  return parts.join(". ");
}

export const ComposerActivityBadge = memo(function ComposerActivityBadge({
  agents,
  expanded,
  onToggle,
  placement = "tab",
  tasks,
}: ComposerActivityFeeds & {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
}) {
  if (!tasks && !agents) return null;

  const row = (
    <ComposerBanner.Row
      render={<button type="button" />}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse activity" : "Activity"}: ${summaryLabel({ agents, tasks })}`}
      data-composer-activity-badge="true"
      onClick={onToggle}
      onPointerDown={(event) => event.preventDefault()}
    >
      <ActivitySummary agents={agents} expanded={expanded} tasks={tasks} />
    </ComposerBanner.Row>
  );
  return placement === "inline" ? (
    row
  ) : (
    <ComposerBanner.Root density="comfortable" data-composer-shoulder-tab>
      {row}
    </ComposerBanner.Root>
  );
});

function ActivityTab({
  count,
  label,
  onSelect,
  panelId,
  selected,
}: {
  readonly count: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly panelId: string;
  readonly selected: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-controls={panelId}
      aria-selected={selected}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-[11px]",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        selected
          ? "bg-foreground/8 font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
      onPointerDown={(event) => event.preventDefault()}
    >
      {label}
      <span className="text-muted-foreground/70 tabular-nums">{count}</span>
    </button>
  );
}

export const ComposerActivityContent = memo(function ComposerActivityContent({
  agents,
  expanded,
  onOpenAgents,
  onTabChange,
  onToggle,
  tab,
  tasks,
}: ComposerActivityFeeds & {
  readonly expanded: boolean;
  readonly onOpenAgents: () => void;
  readonly onTabChange: (tab: ComposerActivityTab) => void;
  readonly onToggle: () => void;
  readonly tab: ComposerActivityTab;
}) {
  const panelId = useId();
  const activeTab = resolveComposerActivityTab(tab, { agents, tasks });
  if (activeTab === null) return null;

  return (
    <div
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-activity-drawer={expanded ? "true" : undefined}
    >
      <ComposerActivityBadge
        agents={agents}
        expanded={expanded}
        onToggle={onToggle}
        placement="inline"
        tasks={tasks}
      />
      {expanded ? (
        <>
          {/* One feed needs no chooser, so the tabs only appear when both are live. */}
          {tasks && agents ? (
            <ComposerBanner.Body
              role="tablist"
              aria-label="Activity feeds"
              className="flex items-center gap-1 pt-1 pb-0.5"
              data-composer-activity-tabs="true"
            >
              <ActivityTab
                count={`${tasks.progress.completedSteps}/${tasks.progress.totalSteps}`}
                label="Tasks"
                panelId={panelId}
                selected={activeTab === "tasks"}
                onSelect={() => onTabChange("tasks")}
              />
              <ActivityTab
                count={agentCountLabel(agents)}
                label="Agents"
                panelId={panelId}
                selected={activeTab === "agents"}
                onSelect={() => onTabChange("agents")}
              />
            </ComposerBanner.Body>
          ) : null}
          <ComposerBanner.Scroll data-composer-activity-scroll="true">
            <div id={panelId} role={tasks && agents ? "tabpanel" : undefined}>
              {activeTab === "tasks" && tasks ? (
                <ComposerTasksList progress={tasks.progress} steps={tasks.steps} />
              ) : null}
              {activeTab === "agents" && agents ? (
                <ComposerAgentsList model={agents} onOpenAgents={onOpenAgents} />
              ) : null}
            </div>
          </ComposerBanner.Scroll>
        </>
      ) : null}
    </div>
  );
});

export const ComposerActivityDrawer = memo(function ComposerActivityDrawer({
  onCollapse,
  ...props
}: Omit<ComponentProps<typeof ComposerActivityContent>, "expanded" | "onToggle"> & {
  readonly onCollapse: () => void;
}) {
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root>
        <ComposerActivityContent {...props} expanded onToggle={onCollapse} />
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
