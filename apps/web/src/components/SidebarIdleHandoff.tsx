// Fork: the hover card line saying when an armed idle handoff fires if the
// thread stays idle. Sidebar.tsx keeps only the call site; the server decides
// the time with the same rules its idle handoff worker fires on.
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { SESSION_IDLE_HANDOFF_DUE_METHOD } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { TimerIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentQuery } from "../state/query";
import { formatShortTimestamp, formatUpcomingTimestamp } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";

// Asked fresh each time a card opens, and dropped when it closes.
const idleHandoffDueAtom = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork:session-idle-handoff-due",
  tag: SESSION_IDLE_HANDOFF_DUE_METHOD,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

/** `Hands off at 12:44 PM if idle`, naming the day once it is not today. */
export function idleHandoffLabel(
  dueAt: string,
  timestampFormat: TimestampFormat,
  nowMs: number,
): string {
  if (Date.parse(dueAt) <= nowMs) return "Hands off now if idle";
  const when = formatUpcomingTimestamp(dueAt, timestampFormat, nowMs);
  return when === formatShortTimestamp(dueAt, timestampFormat)
    ? `Hands off at ${when} if idle`
    : `Hands off ${when} if idle`;
}

/** The card mounts only while open, so the query runs only while it shows. */
export function SidebarIdleHandoffLine(props: {
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // Read once when the card opens: the line is static, never a countdown.
  const [openedAtMs] = useState(() => Date.now());
  const { data } = useEnvironmentQuery(
    idleHandoffDueAtom({
      environmentId: props.thread.environmentId,
      input: { threadId: props.thread.id },
    }),
  );
  if (!data) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TimerIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
      <div className="min-w-0 truncate text-foreground/75">
        {idleHandoffLabel(data.dueAt, timestampFormat, openedAtMs)}
      </div>
    </div>
  );
}
