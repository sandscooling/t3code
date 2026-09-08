import { ThreadId, type AttentionPing } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ATTENTION_FRESHNESS_MS, shouldRingAttentionPing } from "./attention.ts";

const NOW_MS = Date.parse("2026-09-08T12:00:00.000Z");

const ping = (overrides?: Partial<AttentionPing>): AttentionPing => ({
  threadId: ThreadId.make("thread-orchestrator"),
  threadTitle: "orchestrator",
  message: "Ticket 15.8.5 needs a decision",
  sound: "chime",
  requestedAt: "2026-09-08T12:00:00.000Z",
  ...overrides,
});

describe("shouldRingAttentionPing", () => {
  it("rings a fresh ping this client has not heard", () => {
    expect(shouldRingAttentionPing({ ping: ping(), lastRungKey: null, nowMs: NOW_MS })).toBe(true);
  });

  it("stays quiet for the ping it just rang", () => {
    expect(
      shouldRingAttentionPing({
        ping: ping(),
        lastRungKey: "thread-orchestrator:2026-09-08T12:00:00.000Z",
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rings again when the same session asks a second time", () => {
    expect(
      shouldRingAttentionPing({
        ping: ping({ requestedAt: "2026-09-08T12:00:30.000Z" }),
        lastRungKey: "thread-orchestrator:2026-09-08T12:00:00.000Z",
        nowMs: NOW_MS + 30_000,
      }),
    ).toBe(true);
  });

  it("drops a ping older than the freshness window", () => {
    // The subscription re-attaches on reconnect, so a stale ping is a real
    // case: ringing for it teaches the user to ignore the sound.
    expect(
      shouldRingAttentionPing({
        ping: ping(),
        lastRungKey: null,
        nowMs: NOW_MS + ATTENTION_FRESHNESS_MS + 1,
      }),
    ).toBe(false);
  });

  it("rings a ping stamped slightly in the future", () => {
    // Server and client clocks drift; a ping from the near future is certainly
    // not stale.
    expect(
      shouldRingAttentionPing({ ping: ping(), lastRungKey: null, nowMs: NOW_MS - 5_000 }),
    ).toBe(true);
  });

  it("drops a ping with an unreadable timestamp rather than ringing blind", () => {
    expect(
      shouldRingAttentionPing({
        ping: ping({ requestedAt: "not a date" }),
        lastRungKey: null,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});
