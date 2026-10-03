import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { isSidebarThreadInFlight, planProgressPercent } from "./SidebarPlanMeter";

describe("isSidebarThreadInFlight", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("counts a thread paused on approval or input as still in flight", () => {
    // The plan step reads off this: a thread that stops to ask a question is
    // still mid-plan, and testing for "working" alone hid the step at exactly
    // the moment the answer to "which step is it on" matters most.
    for (const status of ["working", "waiting", "approval", "input"] as const) {
      expect(isSidebarThreadInFlight(status)).toBe(true);
    }
    for (const status of ["ready", "failed", "limited"] as const) {
      expect(isSidebarThreadInFlight(status)).toBe(false);
    }
  });

  it("agrees with resolveSidebarThreadStatus for a run paused on approval", () => {
    const status = resolveSidebarThreadStatus({ ...idle, hasPendingApprovals: true, runtime });
    expect(status).toBe("approval");
    expect(isSidebarThreadInFlight(status)).toBe(true);
  });

  it("counts a thread stopped with background work open as in flight", () => {
    const status = resolveSidebarThreadStatus({
      ...idle,
      runtime: { ...runtime, status: "idle" as const },
    });
    expect(status).toBe("waiting");
    expect(isSidebarThreadInFlight(status)).toBe(true);
  });
});

describe("planProgressPercent", () => {
  it("rounds completion to a whole percentage", () => {
    expect(planProgressPercent({ completedSteps: 0, totalSteps: 4 })).toBe(0);
    expect(planProgressPercent({ completedSteps: 1, totalSteps: 4 })).toBe(25);
    expect(planProgressPercent({ completedSteps: 1, totalSteps: 3 })).toBe(33);
    expect(planProgressPercent({ completedSteps: 4, totalSteps: 4 })).toBe(100);
  });

  it("returns zero rather than NaN when there are no steps", () => {
    // A NaN width silently drops the bar's style, which reads as 0% anyway but
    // only after React warns; returning 0 keeps the meter honest and quiet.
    expect(planProgressPercent({ completedSteps: 0, totalSteps: 0 })).toBe(0);
    expect(planProgressPercent({ completedSteps: 3, totalSteps: 0 })).toBe(0);
  });

  it("clamps a snapshot that arrived mid-update", () => {
    expect(planProgressPercent({ completedSteps: 9, totalSteps: 4 })).toBe(100);
    expect(planProgressPercent({ completedSteps: -2, totalSteps: 4 })).toBe(0);
  });
});
