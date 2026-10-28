import { describe, expect, it } from "vite-plus/test";

import { sidebarWaitingOn } from "./backgroundWorkClock";

describe("sidebarWaitingOn", () => {
  const topLevel = {};
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
    expect(sidebarWaitingOn([subagent, devServer], topLevel)).toEqual({
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
    expect(sidebarWaitingOn([subagent, benchmark], topLevel)).toEqual({
      kind: "command",
      startedAt: "2026-10-02T10:05:00.000Z",
    });
  });

  it("reads an awaited monitor and a background task as commands", () => {
    for (const kind of ["monitor", "background_task"] as const) {
      expect(
        sidebarWaitingOn(
          [{ taskId: kind, kind, awaited: true, startedAt: "2026-10-02T10:05:00.000Z" }],
          topLevel,
        ),
      ).toEqual({ kind: "command", startedAt: "2026-10-02T10:05:00.000Z" });
    }
  });

  it("names a pull request watch, without a clock since a watch has no start time", () => {
    expect(
      sidebarWaitingOn(
        [{ taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor", awaited: true }],
        topLevel,
      ),
    ).toEqual({ kind: "pull-request", startedAt: null });
  });

  it("prefers a clocked holding task over a pull request watch", () => {
    const watch = {
      taskId: "pull-request-watch:github.com/acme/app#1",
      kind: "monitor" as const,
      awaited: true as const,
    };
    expect(sidebarWaitingOn([watch, subagent], topLevel)).toEqual({
      kind: "agent",
      startedAt: "2026-10-02T10:00:00.000Z",
    });
  });

  it("keeps the icon without a clock when no holding task reports a start time", () => {
    expect(sidebarWaitingOn([{ taskId: "agent", kind: "subagent" }], topLevel)).toEqual({
      kind: "agent",
      startedAt: null,
    });
  });

  it("is null when nothing holds the thread", () => {
    expect(
      sidebarWaitingOn(
        [{ taskId: "dev", kind: "command", startedAt: "2026-10-02T10:05:00.000Z" }],
        topLevel,
      ),
    ).toBeNull();
  });

  it("clocks and names an unheld command in a crew session, which every command holds", () => {
    const gate = {
      taskId: "gate",
      kind: "command" as const,
      startedAt: "2026-10-02T10:05:00.000Z",
    };
    const crew = { spawnedByThreadId: "orchestrator", title: "t3-x-dev" };
    expect(sidebarWaitingOn([subagent, gate], crew)).toEqual({
      kind: "command",
      startedAt: "2026-10-02T10:05:00.000Z",
    });
    expect(sidebarWaitingOn([gate], crew)).toEqual({
      kind: "command",
      startedAt: "2026-10-02T10:05:00.000Z",
    });
  });
});
