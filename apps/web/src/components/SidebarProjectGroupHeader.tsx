// Fork: the header above one project's rows when the sidebar groups threads
// by project. It folds the group and counts the group's working threads.
import { ChevronDownIcon, FolderIcon } from "lucide-react";

import { cn } from "../lib/utils";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { ProjectFavicon } from "./ProjectFavicon";

export function SidebarProjectGroupHeader(props: {
  group: string;
  project: SidebarProjectSnapshot | null;
  collapsed: boolean;
  workingCount: number;
  onToggle: (group: string) => void;
  onContextMenu: (group: string, position: { x: number; y: number }) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onToggle(props.group)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(props.group, { x: event.clientX, y: event.clientY });
      }}
      aria-expanded={!props.collapsed}
      className="flex h-full w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
    >
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", props.collapsed && "-rotate-90")}
      />
      {props.project ? (
        <ProjectFavicon project={props.project} className="size-3.5 shrink-0" />
      ) : (
        <FolderIcon aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {props.project?.displayName ?? "Other projects"}
      </span>
      {props.workingCount > 0 ? (
        <span className="flex shrink-0 items-center gap-1 tabular-nums text-info">
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {props.workingCount}
          <span className="sr-only"> working or waiting</span>
        </span>
      ) : null}
    </button>
  );
}
