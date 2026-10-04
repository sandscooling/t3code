import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { BotIcon, TerminalIcon } from "lucide-react";
import type { ComponentType } from "react";

import { sidebarWaitingOn } from "./backgroundWorkClock";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Fork: the sidebar's Waiting pill tail. An icon for what holds the thread
 * (bot for an agent, terminal for a command) and its duration, which the
 * caller's ticking component renders.
 */
export function SidebarWaitingOn(props: {
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  Duration: ComponentType<{ startedAt: string | null }>;
}) {
  const waitingOn = sidebarWaitingOn(props.tasks);
  if (waitingOn === null) {
    return null;
  }
  const label = waitingOn.kind === "agent" ? "Waiting on an agent" : "Waiting on a command";
  const Icon = waitingOn.kind === "agent" ? BotIcon : TerminalIcon;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<span role="img" aria-label={label} className="inline-flex shrink-0" />}
        >
          <Icon aria-hidden className="size-4 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <span aria-hidden>
        <props.Duration startedAt={waitingOn.startedAt} />
      </span>
    </>
  );
}
