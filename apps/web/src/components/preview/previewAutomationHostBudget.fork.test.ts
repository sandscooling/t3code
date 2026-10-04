// Fork-owned tests for previewAutomationHostBudget.test.ts.
import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_HOST_RESPONSE_MARGIN_MS,
  resolveHostWaitBudgetMs,
  resolveInPageWaitTimeoutMs,
} from "./previewAutomationHostBudget";

describe("resolveInPageWaitTimeoutMs", () => {
  it("ends a full-length wait before the broker deadline", () => {
    // The broker arms the same 20s; the wait must finish inside the host budget.
    const now = 1_000;
    const hostDeadlineMs = now + resolveHostWaitBudgetMs(20_000);
    const timeoutMs = resolveInPageWaitTimeoutMs(20_000, hostDeadlineMs, now);
    expect(timeoutMs).toBe(20_000 - PREVIEW_HOST_RESPONSE_MARGIN_MS);
    expect(timeoutMs).toBeLessThan(20_000);
  });

  it("bounds the desktop default when the agent passed no timeout", () => {
    expect(resolveInPageWaitTimeoutMs(undefined, 13_500, 0)).toBe(13_500);
  });

  it("keeps a shorter requested wait unchanged", () => {
    expect(resolveInPageWaitTimeoutMs(2_000, 13_500, 0)).toBe(2_000);
  });

  it("subtracts time already spent getting the tab ready", () => {
    expect(resolveInPageWaitTimeoutMs(20_000, 18_500, 4_000)).toBe(14_500);
  });

  it("stays a valid positive timeout once the deadline has passed", () => {
    expect(resolveInPageWaitTimeoutMs(20_000, 5_000, 9_000)).toBe(1);
  });
});
