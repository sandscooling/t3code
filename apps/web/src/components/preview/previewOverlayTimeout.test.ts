import { describe, expect, it } from "vite-plus/test";

import { previewOverlayBudgetMs } from "./previewOverlayTimeout";

describe("previewOverlayBudgetMs", () => {
  it("reserves time from the operation deadline so the renderer error can be reported", () => {
    expect(previewOverlayBudgetMs(15_000)).toBe(14_000);
    expect(previewOverlayBudgetMs(60_000)).toBe(59_000);
  });

  it("halves the deadline instead of going negative when it is shorter than the reserve", () => {
    expect(previewOverlayBudgetMs(1_000)).toBe(500);
    expect(previewOverlayBudgetMs(200)).toBe(100);
  });

  it("leaves the server room to hear back at every supported deadline", () => {
    for (const timeoutMs of [2, 50, 200, 999, 1_000, 1_001, 15_000, 60_000]) {
      const budget = previewOverlayBudgetMs(timeoutMs);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThan(timeoutMs);
    }
  });

  // A 1ms deadline cannot reserve anything and is not worth special-casing; it
  // only has to stay positive so the overlay wait still polls once.
  it("stays positive at the degenerate minimum deadline", () => {
    expect(previewOverlayBudgetMs(1)).toBe(1);
  });
});
