import { ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveProjectStatusIndicator,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
} from "./Sidebar.logic";

// Fork: crew sessions (threads another session spawned) read Idle between turns.
describe("crew session status", () => {
  const runtime = (
    status: "completed" | "running" | "idle" | "failed",
    lastErrorClass: "usage_limit" | null = null,
  ) => ({
    status,
    providerName: "Claude",
    providerInstanceId: ProviderInstanceId.make("claude"),
    activeRunId: null,
    lastError: null,
    lastErrorClass,
    updatedAt: "2026-10-03T10:00:00.000Z",
  });
  // Finished and unread, so a non-crew thread would show Completed.
  const crew = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: {
      runId: "run-1" as never,
      status: "completed" as const,
      requestedAt: null,
      startedAt: "2026-10-03T09:00:00.000Z",
      completedAt: "2026-10-03T10:00:00.000Z",
      assistantMessageId: null,
    },
    lastVisitedAt: "2026-10-03T09:30:00.000Z",
    runtime: runtime("completed"),
    spawnedByThreadId: "orchestrator" as ThreadId | null | undefined,
    settledOverride: null as "settled" | "active" | null,
  };
  const pillLabel = (
    thread: Omit<Partial<Parameters<typeof resolveThreadStatusPill>[0]["thread"]>, "runtime"> & {
      readonly runtime?: ReturnType<typeof runtime>;
    },
  ) => resolveThreadStatusPill({ thread: { ...crew, ...thread } })?.label ?? null;

  it("shows Idle where a finished thread would show Completed", () => {
    expect(pillLabel({})).toBe("Idle");
    expect(pillLabel({ spawnedByThreadId: undefined })).toBe("Completed");
  });

  it("shows Idle where a read thread would show nothing", () => {
    expect(pillLabel({ latestRun: null })).toBe("Idle");
    expect(pillLabel({ latestRun: null, spawnedByThreadId: undefined })).toBeNull();
  });

  it("leaves orchestrators and settled crew sessions alone", () => {
    expect(pillLabel({ spawnedByThreadId: null })).toBe("Completed");
    expect(pillLabel({ settledOverride: "settled" })).toBe("Completed");
  });

  it("lets every live status outrank Idle", () => {
    expect(pillLabel({ hasPendingApprovals: true })).toBe("Pending Approval");
    expect(pillLabel({ hasPendingUserInput: true })).toBe("Awaiting Input");
    expect(pillLabel({ runtime: runtime("running") })).toBe("Working");
    expect(
      pillLabel({
        runtime: runtime("idle"),
        pendingBackgroundTasks: [{ taskId: "bg-1", kind: "monitor" }],
      }),
    ).toBe("Waiting");
    expect(pillLabel({ runtime: runtime("failed") })).not.toBe("Idle");
    expect(pillLabel({ runtime: runtime("failed", "usage_limit") })).not.toBe("Idle");
  });

  it("is not project activity", () => {
    const idle = resolveThreadStatusPill({ thread: crew });
    expect(resolveProjectStatusIndicator([idle, null])).toBeNull();
  });

  it("keeps the group's active count to Working and Waiting", () => {
    // The project group counts "working" and "waiting"; an idle crew session
    // resolves to "ready", so it is not counted.
    expect(resolveSidebarThreadStatus(crew)).toBe("ready");
  });
});
