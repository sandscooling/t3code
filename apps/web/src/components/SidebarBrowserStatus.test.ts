import { describe, expect, it } from "vite-plus/test";

import { browserStatusIndicator } from "./SidebarBrowserStatus";

describe("browserStatusIndicator", () => {
  it("renders nothing when the thread has no browser at all", () => {
    expect(browserStatusIndicator({ hasPreviewSession: false, isAutomating: false })).toBeNull();
  });

  it("dims to a resting icon when a tab exists but nothing is driving it", () => {
    expect(browserStatusIndicator({ hasPreviewSession: true, isAutomating: false })).toMatchObject({
      label: "Browser tab open",
      pulse: false,
    });
  });

  it("lights up while the agent drives the browser", () => {
    expect(browserStatusIndicator({ hasPreviewSession: true, isAutomating: true })).toMatchObject({
      label: "Agent using browser",
      pulse: true,
    });
  });

  it("still lights up when activity outruns the session projection", () => {
    // The first automation request can land before the session list has been
    // reconciled, so activity must not depend on presence being known yet.
    expect(browserStatusIndicator({ hasPreviewSession: false, isAutomating: true })).toMatchObject({
      label: "Agent using browser",
      pulse: true,
    });
  });
});
