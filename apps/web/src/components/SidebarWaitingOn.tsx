import type { EnvironmentId, OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";
import { BotIcon, TerminalIcon } from "lucide-react";
import type { ComponentType } from "react";

import { sidebarWaitingOn } from "./backgroundWorkClock";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";

const WAITING_ON = {
  agent: { label: msg("Waiting on an agent"), Icon: BotIcon },
  command: { label: msg("Waiting on a command"), Icon: TerminalIcon },
  "pull-request": { label: msg("Waiting on a pull request"), Icon: PullRequestGlyph.pullRequest },
} as const;

/**
 * Fork: the sidebar's Waiting pill tail. An icon for what holds the thread
 * (bot for an agent, terminal for a command, pull request for a watch) and its
 * duration, which the caller's ticking component renders.
 */
export function SidebarWaitingOn(props: {
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  thread: Parameters<typeof sidebarWaitingOn>[1];
  environmentId: EnvironmentId;
  Duration: ComponentType<{ environmentId: EnvironmentId; startedAt: string | null }>;
}) {
  const m = useMessages();
  const waitingOn = sidebarWaitingOn(props.tasks, props.thread);
  if (waitingOn === null) {
    return null;
  }
  const { Icon } = WAITING_ON[waitingOn.kind];
  const label = m(WAITING_ON[waitingOn.kind].label);
  return (
    <>
      <SharedTooltipTrigger
        render={<span role="img" aria-label={label} className="inline-flex shrink-0" />}
        label={label}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
      </SharedTooltipTrigger>
      <span aria-hidden>
        <props.Duration environmentId={props.environmentId} startedAt={waitingOn.startedAt} />
      </span>
    </>
  );
}
