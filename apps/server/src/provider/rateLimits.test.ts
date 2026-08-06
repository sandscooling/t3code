import { describe, expect, it } from "vite-plus/test";

import { claudePlanRateLimitWindows } from "./rateLimits.ts";

describe("claudePlanRateLimitWindows", () => {
  it("maps every plan window onto its canonical kind", () => {
    const windows = claudePlanRateLimitWindows({
      five_hour: { utilization: 14, resets_at: "2026-08-06T16:30:00.000Z" },
      seven_day: { utilization: 42, resets_at: "2026-08-10T00:00:00.000Z" },
      seven_day_opus: { utilization: 61, resets_at: "2026-08-10T00:00:00.000Z" },
      seven_day_sonnet: { utilization: 3, resets_at: "2026-08-10T00:00:00.000Z" },
    });

    expect(windows).toEqual([
      {
        kind: "five_hour",
        usedPercent: 14,
        resetsAt: "2026-08-06T16:30:00.000Z",
        windowDurationMins: 300,
      },
      {
        kind: "weekly",
        usedPercent: 42,
        resetsAt: "2026-08-10T00:00:00.000Z",
        windowDurationMins: 10080,
      },
      {
        kind: "weekly_opus",
        usedPercent: 61,
        resetsAt: "2026-08-10T00:00:00.000Z",
        windowDurationMins: 10080,
      },
      {
        kind: "weekly_sonnet",
        usedPercent: 3,
        resetsAt: "2026-08-10T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("keeps a window whose utilization is zero", () => {
    // 0% is a real reading, and `makeRateLimitWindow` only rejects null — this
    // pins that a falsy-but-valid percentage is not dropped.
    const windows = claudePlanRateLimitWindows({
      five_hour: { utilization: 0, resets_at: "2026-08-06T16:30:00.000Z" },
    });

    expect(windows).toEqual([
      {
        kind: "five_hour",
        usedPercent: 0,
        resetsAt: "2026-08-06T16:30:00.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("drops a window with no utilization rather than reporting it as zero", () => {
    // The push `rate_limit_event` shape: window named, reset known, no
    // percentage. Reporting 0% here would render an empty meter as "unused".
    expect(
      claudePlanRateLimitWindows({
        five_hour: { utilization: null, resets_at: "2026-08-06T16:30:00.000Z" },
        seven_day: { utilization: 42, resets_at: "2026-08-10T00:00:00.000Z" },
      }),
    ).toEqual([
      {
        kind: "weekly",
        usedPercent: 42,
        resetsAt: "2026-08-10T00:00:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("keeps a window that reports utilization without a reset instant", () => {
    expect(claudePlanRateLimitWindows({ five_hour: { utilization: 8, resets_at: null } })).toEqual([
      { kind: "five_hour", usedPercent: 8, windowDurationMins: 300 },
    ]);
  });

  it("ignores seven_day_oauth_apps, which meters third-party apps rather than the plan", () => {
    expect(
      claudePlanRateLimitWindows({
        seven_day_oauth_apps: { utilization: 90, resets_at: "2026-08-10T00:00:00.000Z" },
      }),
    ).toEqual([]);
  });

  it("returns no windows when plan limits do not apply", () => {
    // `rate_limits` is null for API key, Bedrock, and Vertex sessions.
    expect(claudePlanRateLimitWindows(null)).toEqual([]);
    expect(claudePlanRateLimitWindows(undefined)).toEqual([]);
  });

  it("survives a malformed payload rather than throwing", () => {
    expect(claudePlanRateLimitWindows("nope")).toEqual([]);
    expect(claudePlanRateLimitWindows({ five_hour: "nope" })).toEqual([]);
    expect(claudePlanRateLimitWindows({ five_hour: { utilization: "14" } })).toEqual([]);
  });

  it("clamps an out-of-range utilization onto 0-100", () => {
    expect(claudePlanRateLimitWindows({ five_hour: { utilization: 130 } })[0]?.usedPercent).toBe(
      100,
    );
    expect(claudePlanRateLimitWindows({ five_hour: { utilization: -5 } })[0]?.usedPercent).toBe(0);
  });
});
