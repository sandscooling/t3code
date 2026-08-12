import { describe, expect, it } from "vite-plus/test";

import { elapsedBetween, isAgentTicking } from "./AgentElapsed";

const START = "2026-08-11T12:00:00.000Z";

function plus(seconds: number): string {
  return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

describe("elapsedBetween", () => {
  it("counts seconds under a minute", () => {
    expect(elapsedBetween(START, plus(0))).toBe("0s");
    expect(elapsedBetween(START, plus(59))).toBe("59s");
  });

  it("switches to zero-padded minutes at the boundary", () => {
    expect(elapsedBetween(START, plus(60))).toBe("1m 00s");
    expect(elapsedBetween(START, plus(83))).toBe("1m 23s");
    expect(elapsedBetween(START, plus(3599))).toBe("59m 59s");
  });

  it("drops seconds once an hour is on the clock", () => {
    expect(elapsedBetween(START, plus(3600))).toBe("1h 00m");
    expect(elapsedBetween(START, plus(3600 + 5 * 60 + 42))).toBe("1h 05m");
  });

  it("floors a clock that ran backwards to zero rather than showing a negative", () => {
    expect(elapsedBetween(START, plus(-30))).toBe("0s");
  });

  it("returns nothing renderable for an unparseable timestamp", () => {
    expect(elapsedBetween("not-a-date", plus(60))).toBe("");
    expect(elapsedBetween(START, "not-a-date")).toBe("");
  });
});

describe("isAgentTicking", () => {
  // Drives both the composer bar's clock and its dropped "Working" label, so
  // a status landing on the wrong side shows a frozen number on a live row.
  it("ticks only for the states that are actively accruing time", () => {
    expect(isAgentTicking("running")).toBe(true);
    expect(isAgentTicking("waiting")).toBe(true);
  });

  it("holds still for pending, idle, and every settled state", () => {
    expect(isAgentTicking("pending")).toBe(false);
    expect(isAgentTicking("idle")).toBe(false);
    expect(isAgentTicking("completed")).toBe(false);
    expect(isAgentTicking("failed")).toBe(false);
    expect(isAgentTicking("cancelled")).toBe(false);
    expect(isAgentTicking("interrupted")).toBe(false);
  });
});
