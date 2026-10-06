// Fork tests for claudeUsageLimits.test.ts.
import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate } from "./claudeUsageLimits.ts";

const noNames = { overageIncluded: undefined } as const;

describe("claudeRateLimitEventToUpdate", () => {
  // Fork: the shape a Claude account with headroom streams on every response.
  it("reads every account-wide window from unifiedWindows when no utilization is named", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "five_hour",
          resetsAt: 1_790_404_800,
          unifiedWindows: {
            five_hour: { utilization: 0.1, resetsAt: 1_790_404_800 },
            seven_day: { utilization: 0.02, resetsAt: 1_790_946_000 },
            seven_day_opus: { utilization: 0.5 },
          },
        } as never,
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 10,
          windowDurationMins: 300,
          resetsAt: "2026-09-26T06:40:00.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 2,
          windowDurationMins: 10080,
          resetsAt: "2026-10-02T13:00:00.000Z",
        },
      ],
    });
  });
});
