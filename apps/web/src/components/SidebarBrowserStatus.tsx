// Fork: the globe a sidebar row shows while its thread has a browser tab open.
// Sidebar.tsx keeps only the call sites.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { GlobeIcon } from "lucide-react";

import { previewStateAtom } from "../previewStateStore";
import type { SidebarThreadSummary } from "../types";

const LABEL = "Browser tab open";
const COLOR_CLASS = "text-muted-foreground/40";

// Sidebar rows only need "does this thread have a browser open", and one row
// exists per thread on screen. Deriving the boolean keeps a row from
// re-rendering on every navigation event in its own thread, and keeps it off
// the cross-thread index entirely.
const threadHasPreviewSessionAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => Object.keys(get(previewStateAtom(threadKey)).sessions).length > 0).pipe(
    Atom.withLabel(`preview:has-session:${threadKey}`),
  ),
);

/** Whether one thread's sidebar row shows the globe. */
export function useSidebarBrowserStatus(ref: ScopedThreadRef): boolean {
  return useAtomValue(threadHasPreviewSessionAtom(scopedThreadKey(ref)));
}

/** The globe beside the row title. */
export function SidebarBrowserStatusIcon(props: { status: boolean; threadId: string }) {
  if (!props.status) return null;
  return (
    <span
      role="img"
      aria-label={LABEL}
      data-testid={`sidebar-browser-status-${props.threadId}`}
      className={`inline-flex shrink-0 items-center justify-center ${COLOR_CLASS}`}
    >
      <GlobeIcon className="size-3.5" />
    </span>
  );
}

/** The browser tab line in the row's hover card, beside the terminal one. The
    card mounts only while open, so this subscribes only while it shows. */
export function SidebarBrowserStatusLine(props: {
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">;
}) {
  const hasBrowserTab = useSidebarBrowserStatus(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
  );
  if (!hasBrowserTab) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <GlobeIcon aria-hidden className={`size-3 shrink-0 ${COLOR_CLASS}`} />
      <div className="min-w-0 truncate text-foreground/75">{LABEL}</div>
    </div>
  );
}
