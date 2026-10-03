// Fork: the globe a sidebar row shows while its thread has a browser tab, lit
// and pulsing while an agent drives it. Sidebar.tsx keeps only the call sites.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { GlobeIcon } from "lucide-react";

import { useThreadBrowserAutomationActive } from "../browser/browserAutomationActivityStore";
import { cn } from "../lib/utils";
import { previewStateAtom } from "../previewStateStore";
import type { SidebarThreadSummary } from "../types";
import { synchronizeTerminalPulse } from "./ThreadStatusIndicators";

export interface BrowserStatusIndicator {
  label: "Agent using browser" | "Browser tab open";
  colorClass: string;
  pulse: boolean;
}

export function browserStatusIndicator(input: {
  readonly hasPreviewSession: boolean;
  readonly isAutomating: boolean;
}): BrowserStatusIndicator | null {
  if (input.isAutomating) {
    return {
      label: "Agent using browser",
      colorClass: "text-sky-600 dark:text-sky-300/90",
      pulse: true,
    };
  }
  if (input.hasPreviewSession) {
    return {
      label: "Browser tab open",
      colorClass: "text-muted-foreground/40",
      pulse: false,
    };
  }
  return null;
}

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
export function useSidebarBrowserStatus(ref: ScopedThreadRef): BrowserStatusIndicator | null {
  const threadKey = scopedThreadKey(ref);
  return browserStatusIndicator({
    hasPreviewSession: useAtomValue(threadHasPreviewSessionAtom(threadKey)),
    isAutomating: useThreadBrowserAutomationActive(threadKey),
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
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">;
}) {
  const status = useSidebarBrowserStatus(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
  );
  if (!status) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <GlobeIcon aria-hidden className={cn("size-3 shrink-0", status.colorClass)} />
      <div className="min-w-0 truncate text-foreground/75">{status.label}</div>
    </div>
  );
}
