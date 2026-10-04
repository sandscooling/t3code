// The fork's tests for orchestrationV2PendingBackgroundWork.test.ts.
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { derivePendingBackgroundWork } from "./orchestrationV2PendingBackgroundWork.ts";

// Fork: startedAt lets a client show how long background work has run.
describe("derivePendingBackgroundWork startedAt", () => {
  it("keeps the roster's start, takes an item's, and fills a roster entry from its item", () => {
    const itemStart = DateTime.makeUnsafe("2026-10-02T10:05:00.000Z");
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "watch", kind: "monitor", startedAt: "2026-10-02T10:00:00.000Z" },
            { taskId: "sub", kind: "subagent" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Review",
          nativeItemRef: { nativeId: "sub" },
          startedAt: itemStart,
        },
        {
          id: "item-cmd" as never,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "cmd" },
          input: "npm test",
          startedAt: itemStart,
        },
        {
          id: "item-unstarted" as never,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "unstarted" },
          input: "npm run dev",
          startedAt: null,
        },
      ],
    });
    expect(tasks.map((task) => [task.taskId, task.startedAt])).toEqual([
      ["watch", "2026-10-02T10:00:00.000Z"],
      ["sub", "2026-10-02T10:05:00.000Z"],
      ["cmd", "2026-10-02T10:05:00.000Z"],
      ["unstarted", undefined],
    ]);
  });
});
