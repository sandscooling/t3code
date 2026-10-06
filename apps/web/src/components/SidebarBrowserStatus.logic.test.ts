import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { type BrowserStatusThread, browserStatusIndicator } from "./SidebarBrowserStatus.logic";

function thread(
  status: ThreadRuntimeSummary["status"] | null,
  overrides: Partial<BrowserStatusThread> = {},
): BrowserStatusThread {
  return {
    runtime: status === null ? null : ({ status } as ThreadRuntimeSummary),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("browserStatusIndicator", () => {
  it("shows nothing without a browser tab, even while working", () => {
    expect(browserStatusIndicator({ hasPreviewSession: false, thread: thread("running") })).toBe(
      null,
    );
  });

  it("lights up while a thread with a tab is working", () => {
    for (const status of ["running", "waiting"] as const) {
      expect(
        browserStatusIndicator({ hasPreviewSession: true, thread: thread(status) }),
      ).toMatchObject({ label: "Agent using browser", pulse: true });
    }
  });

  it("dims when the turn is not working", () => {
    for (const status of [null, "idle", "completed", "starting", "queued"] as const) {
      expect(
        browserStatusIndicator({ hasPreviewSession: true, thread: thread(status) }),
      ).toMatchObject({ label: "Browser tab open", pulse: false });
    }
  });

  it("dims while the agent is blocked on the user", () => {
    for (const overrides of [{ hasPendingApprovals: true }, { hasPendingUserInput: true }]) {
      expect(
        browserStatusIndicator({ hasPreviewSession: true, thread: thread("running", overrides) }),
      ).toMatchObject({ label: "Browser tab open", pulse: false });
    }
  });

  it("returns the same object across calls, so rows keep a stable value", () => {
    const input = { hasPreviewSession: true, thread: thread("running") };
    expect(browserStatusIndicator(input)).toBe(browserStatusIndicator(input));
  });
});
