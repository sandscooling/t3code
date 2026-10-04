// Fork-owned tests for ChatView.logic.test.ts.
import { describe, expect, it } from "vite-plus/test";

import { backgroundWorkClockStartedAt } from "./ChatView.logic";

// Fork: the background work banner's clock.
describe("backgroundWorkClockStartedAt", () => {
  const tasks = [
    { taskId: "watch", kind: "monitor" as const, startedAt: "2026-10-02T10:00:00.000Z" },
    { taskId: "build", kind: "command" as const, startedAt: "2026-10-02T10:05:00.000Z" },
    { taskId: "old", kind: "background_task" as const },
  ];

  it("clocks the newest task", () => {
    expect(backgroundWorkClockStartedAt(tasks)).toBe("2026-10-02T10:05:00.000Z");
  });

  it("shows no clock when no task reports a start time", () => {
    expect(backgroundWorkClockStartedAt([{ taskId: "old", kind: "command" }])).toBeNull();
  });
});
