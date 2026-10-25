// The fork's tests for entities.test.ts.
import { EnvironmentId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { deriveThreadRuntime } from "./threadExecution.ts";

const environmentId = EnvironmentId.make("environment-v2");

describe("V2 client presentation", () => {
  // Fork: lane, spawn lineage and successor reach the client only when sent.
  it("copies the fork's session fields when present and leaves them absent otherwise", () => {
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      group: "v2-web-sidebar",
      spawnedByThreadId: ThreadId.make("thread-orchestrator"),
      successorThreadId: null,
    });
    expect(shell.group).toBe("v2-web-sidebar");
    expect(shell.spawnedByThreadId).toBe("thread-orchestrator");
    expect(shell.successorThreadId).toBeNull();

    const bare = presentThreadShell(environmentId, v2ThreadShell);
    for (const key of ["group", "spawnedByThreadId", "successorThreadId"]) {
      expect(bare).not.toHaveProperty(key);
    }
  });
});

// Fork: a crew session resumes when any command it left running ends, so an
// unheld command holds it Waiting; elsewhere only a held one does.
describe("crew sessions wait on unheld commands", () => {
  const now = DateTime.makeUnsafe("2026-10-24T22:00:00.000Z");
  const crew = { spawnedByThreadId: ThreadId.make("thread-orchestrator") };
  const gate = { taskId: "gate", kind: "command" as const };

  it("parks a crew shell at idle while an unheld command runs", () => {
    const shell = (fields: Partial<typeof v2ThreadShell>) =>
      presentThreadShell(environmentId, {
        ...v2ThreadShell,
        latestRunId: RunId.make("run-gate"),
        status: "completed",
        ...fields,
      }).runtime?.status;

    expect(shell({ ...crew, pendingBackgroundTasks: [gate] })).toBe("idle");
    expect(shell({ pendingBackgroundTasks: [gate] })).toBe("completed");
    expect(shell({ ...crew, title: "Orchestrator", pendingBackgroundTasks: [gate] })).toBe(
      "completed",
    );
    expect(shell({ ...crew, pendingBackgroundTasks: [] })).toBe("completed");
  });

  it("parks a crew projection at idle while an unheld command runs", () => {
    const runId = RunId.make("run-gate");
    const run = {
      id: runId,
      threadId: v2Projection.thread.id,
      ordinal: 1,
      providerInstanceId: v2Projection.thread.providerInstanceId,
      modelSelection: v2Projection.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message-gate"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const command = {
      id: TurnItemId.make("item-gate"),
      threadId: v2Projection.thread.id,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running" as const,
      title: "Lint and typecheck",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution" as const,
      input: "vp run check:changed",
    };
    const runtime = (thread: typeof v2Projection.thread) =>
      deriveThreadRuntime({ ...v2Projection, thread, runs: [run], turnItems: [command] })?.status;

    expect(runtime({ ...v2Projection.thread, ...crew })).toBe("idle");
    expect(runtime(v2Projection.thread)).toBe("completed");
  });
});
