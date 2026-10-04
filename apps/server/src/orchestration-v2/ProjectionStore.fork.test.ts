// Fork tests for ProjectionStore.test.ts.
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const TestLayer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

it.layer(TestLayer)("ProjectionStoreV2", (it) => {
  // Fork: the sidebar plan meter reads planProgress off the shell.
  it.effect("projects the running run's latest todo list progress into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("plan-progress");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      let eventNumber = 0;
      const applyRun = (status: typeof original.status) =>
        store.apply({
          id: EventId.make(`event:plan-progress:run:${++eventNumber}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, status },
        });
      const applyTodoList = (ordinal: number, statuses: ReadonlyArray<string>) =>
        store.apply({
          id: EventId.make(`event:plan-progress:todo:${++eventNumber}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`plan-progress:todo:${ordinal}`),
            threadId,
            runId: original.id,
            nodeId: original.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "todo_list" as const,
            planId: PlanId.make(`plan-progress:plan:${ordinal}`),
            steps: statuses.map((status, index) => ({
              id: `step-${index}`,
              text: `Step ${index}`,
              status: status as "pending" | "running" | "completed",
            })),
          },
        });
      const assertProgress = Effect.fnUntraced(function* (
        expected: { readonly completedSteps: number; readonly totalSteps: number } | null,
      ) {
        const memoryShell = ProjectionStore.threadShellFromProjection(
          yield* store.getThreadProjection(threadId),
        );
        const sqlShell = (yield* store.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        )!;
        assert.deepEqual(memoryShell.planProgress, expected);
        assert.deepEqual(sqlShell.planProgress, expected);
      });

      yield* applyRun("running");
      yield* assertProgress(null);
      // An older list in the same run loses to the newest one.
      yield* applyTodoList(2, ["completed", "pending", "pending"]);
      yield* applyTodoList(3, ["completed", "completed", "running", "pending"]);
      yield* assertProgress({ completedSteps: 2, totalSteps: 4 });
      // A finished list shows no meter, even with an older unfinished one.
      yield* applyTodoList(3, ["completed", "completed", "completed", "completed"]);
      yield* assertProgress(null);
      yield* applyTodoList(3, ["completed", "running", "pending", "pending"]);
      yield* assertProgress({ completedSteps: 1, totalSteps: 4 });
      // Only while the run runs.
      yield* applyRun("completed");
      yield* assertProgress(null);
    }),
  );
});
