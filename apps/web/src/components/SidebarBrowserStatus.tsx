// Fork: the globe a sidebar row shows while its thread has a browser tab open,
// lit and pulsing while its agent is working. Sidebar.tsx keeps only the call
// sites; SidebarBrowserStatus.logic.ts decides the state.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { GlobeIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { previewStateAtom } from "../previewStateStore";
import type { SidebarThreadSummary } from "../types";
import {
  type BrowserStatusIndicator,
  type BrowserStatusThread,
  browserStatusIndicator,
} from "./SidebarBrowserStatus.logic";
import { synchronizeTerminalPulse } from "./ThreadStatusIndicators";

// Sidebar rows only need "does this thread have a browser open", and one row
// exists per thread on screen. Deriving the boolean keeps a row from
// re-rendering on every navigation event in its own thread, and keeps it off
// the cross-thread index entirely.
const threadHasPreviewSessionAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => Object.keys(get(previewStateAtom(threadKey)).sessions).length > 0).pipe(
    Atom.withLabel(`preview:has-session:${threadKey}`),
  ),
);

/** The globe state for one thread's sidebar row. */
export function useSidebarBrowserStatus(
  ref: ScopedThreadRef,
  thread: BrowserStatusThread,
): BrowserStatusIndicator | null {
  return browserStatusIndicator({
    hasPreviewSession: useAtomValue(threadHasPreviewSessionAtom(scopedThreadKey(ref))),
    thread,
  });
}

/** The globe beside the row title, pulsing in step with the terminal icon. */
export function SidebarBrowserStatusIcon(props: {
  status: BrowserStatusIndicator | null;
  threadId: string;
}) {
  if (!props.status) return null;
  return (
    <span
      role="img"
      aria-label={props.status.label}
      data-testid={`sidebar-browser-status-${props.threadId}`}
      className={cn("inline-flex shrink-0 items-center justify-center", props.status.colorClass)}
    >
      <GlobeIcon
        className={cn("size-3.5", props.status.pulse && "motion-safe:animate-status-pulse")}
        onAnimationStart={synchronizeTerminalPulse}
      />
    </span>
  );
}

/** The browser tab line in the row's hover card, beside the terminal one. The
    card mounts only while open, so this subscribes only while it shows. */
export function SidebarBrowserStatusLine(props: {
  thread: Pick<SidebarThreadSummary, "environmentId" | "id"> & BrowserStatusThread;
}) {
  const status = useSidebarBrowserStatus(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
    props.thread,
  );
  if (!status) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <GlobeIcon aria-hidden className={cn("size-3 shrink-0", status.colorClass)} />
      <div className="min-w-0 truncate text-foreground/75">{status.label}</div>
    </div>
  );
}
