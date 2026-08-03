import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveRateLimitSnapshot,
  formatRateLimitPercent,
  formatRateLimitReset,
  formatRateLimitWindowLabel,
  peakRateLimitWindow,
} from "./rateLimits";

const NOW = Date.parse("2026-03-23T00:00:00.000Z");

function makeActivity(
  id: string,
  payload: unknown,
  createdAt = "2026-03-23T00:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "rate-limits.updated",
    summary: "Usage limits updated",
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt,
  };
}

function futureIso(minutesFromNow: number): string {
  return new Date(NOW + minutesFromNow * 60_000).toISOString();
}

describe("deriveRateLimitSnapshot", () => {
  it("merges sparse per-window updates into one snapshot", () => {
    // Claude sends one window per event, so 5h and weekly never share an event.
    const snapshot = deriveRateLimitSnapshot(
      [
        makeActivity("a1", {
          windows: [{ kind: "five_hour", usedPercent: 12, resetsAt: futureIso(60) }],
        }),
        makeActivity("a2", {
          windows: [{ kind: "weekly", usedPercent: 41, resetsAt: futureIso(4 * 24 * 60) }],
        }),
        makeActivity("a3", {
          windows: [{ kind: "five_hour", usedPercent: 37, resetsAt: futureIso(45) }],
        }),
      ],
      { now: NOW },
    );

    expect(snapshot?.windows.map((window) => [window.kind, window.usedPercent])).toEqual([
      ["five_hour", 37],
      ["weekly", 41],
    ]);
  });

  it("keeps the newest observation of a window kind", () => {
    const snapshot = deriveRateLimitSnapshot(
      [
        makeActivity("a1", { windows: [{ kind: "five_hour", usedPercent: 80 }] }),
        makeActivity("a2", { windows: [{ kind: "five_hour", usedPercent: 3 }] }),
      ],
      { now: NOW },
    );

    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.windows[0]?.usedPercent).toBe(3);
  });

  it("drops windows whose reset has already passed", () => {
    const snapshot = deriveRateLimitSnapshot(
      [
        makeActivity("a1", {
          windows: [
            { kind: "five_hour", usedPercent: 90, resetsAt: "2026-03-22T23:00:00.000Z" },
            { kind: "weekly", usedPercent: 20, resetsAt: futureIso(2 * 24 * 60) },
          ],
        }),
      ],
      { now: NOW },
    );

    expect(snapshot?.windows.map((window) => window.kind)).toEqual(["weekly"]);
  });

  it("returns null when no window survives", () => {
    expect(
      deriveRateLimitSnapshot(
        [
          makeActivity("a1", { windows: [] }),
          makeActivity("a2", { windows: [{ kind: "five_hour" }] }),
          makeActivity("a3", { windows: "nope" }),
        ],
        { now: NOW },
      ),
    ).toBeNull();
    expect(deriveRateLimitSnapshot([], { now: NOW })).toBeNull();
  });

  it("clamps utilization and defaults unrecognized kinds", () => {
    const snapshot = deriveRateLimitSnapshot(
      [makeActivity("a1", { windows: [{ kind: "fortnightly", usedPercent: 140 }] })],
      { now: NOW },
    );

    expect(snapshot?.windows[0]?.kind).toBe("unknown");
    expect(snapshot?.windows[0]?.usedPercent).toBe(100);
  });

  it("carries the plan label from the newest event that has one", () => {
    const snapshot = deriveRateLimitSnapshot(
      [
        makeActivity("a1", { windows: [{ kind: "weekly", usedPercent: 5 }], planLabel: "pro" }),
        makeActivity("a2", { windows: [{ kind: "five_hour", usedPercent: 5 }] }),
      ],
      { now: NOW },
    );

    expect(snapshot?.planLabel).toBe("pro");
  });
});

describe("peakRateLimitWindow", () => {
  it("returns the most-used window", () => {
    const snapshot = deriveRateLimitSnapshot(
      [
        makeActivity("a1", {
          windows: [
            { kind: "five_hour", usedPercent: 12 },
            { kind: "weekly", usedPercent: 66 },
          ],
        }),
      ],
      { now: NOW },
    );

    expect(peakRateLimitWindow(snapshot!)?.kind).toBe("weekly");
  });
});

describe("formatting", () => {
  it("labels known kinds and falls back to the reported duration", () => {
    expect(formatRateLimitWindowLabel({ kind: "five_hour" })).toBe("5h");
    expect(formatRateLimitWindowLabel({ kind: "weekly_opus" })).toBe("Weekly (Opus)");
    expect(formatRateLimitWindowLabel({ kind: "unknown", windowDurationMins: 180 })).toBe("3h");
    expect(formatRateLimitWindowLabel({ kind: "unknown", windowDurationMins: 43_200 })).toBe("30d");
    expect(formatRateLimitWindowLabel({ kind: "unknown" })).toBe("Usage");
  });

  it("formats percentages without implying false precision", () => {
    expect(formatRateLimitPercent(0)).toBe("0%");
    expect(formatRateLimitPercent(0.4)).toBe("<1%");
    expect(formatRateLimitPercent(37.6)).toBe("38%");
  });

  it("formats reset countdowns and drops elapsed ones", () => {
    expect(formatRateLimitReset(futureIso(45), NOW)).toBe("45m");
    expect(formatRateLimitReset(futureIso(150), NOW)).toBe("2h 30m");
    expect(formatRateLimitReset(futureIso(120), NOW)).toBe("2h");
    expect(formatRateLimitReset(futureIso(3 * 24 * 60), NOW)).toBe("3d");
    expect(formatRateLimitReset("2026-03-22T00:00:00.000Z", NOW)).toBeNull();
    expect(formatRateLimitReset("not-a-date", NOW)).toBeNull();
  });
});
