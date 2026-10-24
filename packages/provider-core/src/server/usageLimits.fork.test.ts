// Fork tests for usageLimits.ts: the `complete` update carried from upstream #24128.
import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 16,
  windowDurationMins: 300,
  resetsAt: "2026-10-24T09:20:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 14,
  windowDurationMins: 10_080,
  resetsAt: "2026-10-30T13:00:00.000Z",
} as const;

const failedProbe = (checkedAt: string) => ({
  checkedAt,
  windows: [],
  unavailable: { reason: "probeFailed" as const },
});

describe("usage windows across failed probes", () => {
  // The composer pill blinked out once a minute: get_usage answered without
  // rate limits, a turn streamed every window, and the next refresh dropped them.
  it("keeps a complete streamed reading through the next failed probe", () => {
    const afterFirstProbe = resolveUsageLimitsAfterProbe({
      published: undefined,
      probed: failedProbe("2026-10-24T05:48:36.000Z"),
    });
    const streamed = applyUsageLimitsUpdate({
      previous: afterFirstProbe,
      checkedAt: "2026-10-24T05:48:56.000Z",
      update: { complete: true, windows: [session, weekly] },
    });
    const afterSecondProbe = resolveUsageLimitsAfterProbe({
      published: streamed,
      probed: failedProbe("2026-10-24T05:49:36.000Z"),
    });

    expect(afterSecondProbe).toEqual({
      checkedAt: "2026-10-24T05:48:56.000Z",
      windows: [session, weekly],
    });
  });

  it("still lets the next failed probe replace a sparse streamed reading", () => {
    const streamed = applyUsageLimitsUpdate({
      previous: failedProbe("2026-10-24T05:48:36.000Z"),
      checkedAt: "2026-10-24T05:48:56.000Z",
      update: { windows: [session] },
    });
    expect(streamed?.unavailable).toEqual({ reason: "probeFailed" });

    const nextProbe = failedProbe("2026-10-24T05:49:36.000Z");
    expect(resolveUsageLimitsAfterProbe({ published: streamed, probed: nextProbe })).toBe(
      nextProbe,
    );
  });

  it("does not let a complete reading revive an unsupported account", () => {
    const unsupported = {
      checkedAt: "2026-10-24T05:48:36.000Z",
      windows: [],
      unavailable: { reason: "unsupported" as const },
    };
    expect(
      applyUsageLimitsUpdate({
        previous: unsupported,
        checkedAt: "2026-10-24T05:48:56.000Z",
        update: { complete: true, windows: [session, weekly] },
      }),
    ).toBe(unsupported);
  });
});
