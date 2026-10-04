// Fork-owned tests for session-logic.test.ts.
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveHandoffFollow } from "./session-logic";

// Fork: following an orchestrator handoff on the v2 shell field.
describe("resolveHandoffFollow", () => {
  const older = ThreadId.make("thread-older");
  const newer = ThreadId.make("thread-newer");

  it("takes the first snapshot as the baseline, so reopening a replaced thread stays put", () => {
    expect(resolveHandoffFollow(null, "env:old", older)).toEqual({
      baseline: { threadKey: "env:old", successorThreadId: older },
      follow: null,
    });
  });

  it("follows a succession that arrives while the thread is open", () => {
    const opened = resolveHandoffFollow(null, "env:old", undefined).baseline;
    expect(resolveHandoffFollow(opened, "env:old", null).follow).toBeNull();
    const handedOff = resolveHandoffFollow(opened, "env:old", older);
    expect(handedOff.follow).toBe(older);
    expect(resolveHandoffFollow(handedOff.baseline, "env:old", older).follow).toBeNull();
    expect(resolveHandoffFollow(handedOff.baseline, "env:old", newer).follow).toBe(newer);
  });

  it("rebaselines when the reader moves to another thread", () => {
    const opened = resolveHandoffFollow(null, "env:a", null).baseline;
    expect(resolveHandoffFollow(opened, "env:b", older)).toEqual({
      baseline: { threadKey: "env:b", successorThreadId: older },
      follow: null,
    });
  });
});
