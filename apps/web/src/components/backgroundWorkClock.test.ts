import { describe, expect, it } from "vite-plus/test";

import { backgroundWorkClockStartedAt, sidebarWaitingOn } from "./backgroundWorkClock";

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

describe("sidebarWaitingOn", () => {
  const subagent = {
    taskId: "agent",
    kind: "subagent" as const,
    startedAt: "2026-10-02T10:00:00.000Z",
  };

  it("ignores an unheld command started after the subagent that holds the thread", () => {
    const devServer = {
      taskId: "dev",
      kind: "command" as const,
      startedAt: "2026-10-02T10:05:00.000Z",
    };
    expect(sidebarWaitingOn([subagent, devServer])).toEqual({
      kind: "agent",
      startedAt: "2026-10-02T10:00:00.000Z",
    });
  });

  it("clocks the newest holding task and names its kind", () => {
    const benchmark = {
      taskId: "bench",
      kind: "command" as const,
      held: true,
      startedAt: "2026-10-02T10:05:00.000Z",
    };
    expect(sidebarWaitingOn([subagent, benchmark])).toEqual({
      kind: "command",
      startedAt: "2026-10-02T10:05:00.000Z",
    });
  });

  it("reads a monitor and a background task as commands", () => {
    for (const kind of ["monitor", "background_task"] as const) {
      expect(
        sidebarWaitingOn([{ taskId: kind, kind, startedAt: "2026-10-02T10:05:00.000Z" }]),
      ).toEqual({ kind: "command", startedAt: "2026-10-02T10:05:00.000Z" });
    }
  });

  it("names a pull request watch, without a clock since a watch has no start time", () => {
    expect(
      sidebarWaitingOn([{ taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" }]),
    ).toEqual({ kind: "pull-request", startedAt: null });
  });

  it("prefers a clocked holding task over a pull request watch", () => {
    const watch = { taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" as const };
    expect(sidebarWaitingOn([watch, subagent])).toEqual({
      kind: "agent",
      startedAt: "2026-10-02T10:00:00.000Z",
    });
  });

  it("keeps the icon without a clock when no holding task reports a start time", () => {
    expect(sidebarWaitingOn([{ taskId: "agent", kind: "subagent" }])).toEqual({
      kind: "agent",
      startedAt: null,
    });
  });

  it("is null when nothing holds the thread", () => {
    expect(
      sidebarWaitingOn([{ taskId: "dev", kind: "command", startedAt: "2026-10-02T10:05:00.000Z" }]),
    ).toBeNull();
  });
});
