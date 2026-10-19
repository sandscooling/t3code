import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for background work holds"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "background-work-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.layer(testLayer)("thread.background-work.hold", (it) => {
  it.effect("waits for the commands that run now, then stops waiting", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:background-work-hold");
      const runId = RunId.make("run:background-work-hold");
      const nodeId = NodeId.make("node:background-work-hold");
      const now = yield* DateTime.now;
      const hold = (commandId: string, held: boolean) =>
        orchestrator.dispatch({
          type: "thread.background-work.hold",
          commandId: CommandId.make(commandId),
          threadId,
          held,
        });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-background-work-hold"),
        threadId,
        projectId: ProjectId.make("project:background-work-hold"),
        title: "Benchmarks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      // Nothing runs yet, so there is nothing to wait for. The MCP tool relies
      // on this tag to tell the rejection apart from an outage.
      const nothing = yield* Effect.flip(hold("hold-nothing", true));
      assert.equal(nothing._tag, "OrchestratorCommandRejectedError");

      // The turn ended and left its benchmark running in the background.
      yield* projections.apply({
        id: EventId.make("event:background-work-hold:run"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:background-work-hold"),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:background-work-hold:command"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:bench"),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "Run benchmarks",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "cargo bench",
          output: "",
        },
      });
      const running = {
        taskId: "item:bench",
        description: "Run benchmarks",
        // Fork: background tasks carry their item's start for the background clock.
        startedAt: "1970-01-01T00:00:00.000Z",
        kind: "command" as const,
      };
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks, [
        running,
      ]);

      yield* hold("hold-bench", true);
      assert.deepEqual(
        (yield* projections.getThreadProjection(threadId)).thread.heldBackgroundTaskIds,
        ["item:bench"],
      );
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks, [
        { ...running, held: true },
      ]);

      yield* hold("release-bench", false);
      assert.isUndefined(
        (yield* projections.getThreadProjection(threadId)).thread.heldBackgroundTaskIds,
      );
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.pendingBackgroundTasks, [
        running,
      ]);
    }),
  );

  it.effect("holds only the latest run's commands, never a dev server from an earlier run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:background-work-scope");
      const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
      const hold = (commandId: string) =>
        orchestrator.dispatch({
          type: "thread.background-work.hold",
          commandId: CommandId.make(commandId),
          threadId,
          held: true,
        });
      const heldIds = Effect.map(
        projections.getThreadProjection(threadId),
        (projection) => projection.thread.heldBackgroundTaskIds,
      );
      const run = (
        ordinal: number,
        status: "running" | "completed",
        type: "run.created" | "run.updated" = "run.created",
      ) => {
        const runId = RunId.make(`run:scope:${ordinal}`);
        return projections.apply({
          id: EventId.make(`event:scope:run:${ordinal}:${status}`),
          type,
          threadId,
          runId,
          occurredAt: at(ordinal * 10),
          payload: {
            id: runId,
            threadId,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:scope:${ordinal}`),
            rootNodeId: NodeId.make(`node:scope:${ordinal}`),
            activeAttemptId: null,
            status,
            requestedAt: at(ordinal * 10),
            startedAt: at(ordinal * 10),
            completedAt: status === "completed" ? at(ordinal * 10 + 9) : null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      };
      const command = (
        name: string,
        runOrdinal: number,
        startedSecond: number,
        status: "running" | "completed",
      ) => {
        const runId = RunId.make(`run:scope:${runOrdinal}`);
        const nodeId = NodeId.make(`node:scope:${runOrdinal}`);
        return projections.apply({
          id: EventId.make(`event:scope:${name}:${status}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: at(startedSecond),
          payload: {
            id: TurnItemId.make(name),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status,
            title: name,
            startedAt: at(startedSecond),
            completedAt: status === "completed" ? at(startedSecond + 1) : null,
            updatedAt: at(startedSecond),
            type: "command_execution",
            input: name,
            output: "",
          },
        });
      };
      const shellTasks = Effect.map(
        projections.getThreadShell(threadId),
        (shell) => shell?.pendingBackgroundTasks ?? [],
      );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-background-work-scope"),
        threadId,
        projectId: ProjectId.make("project:background-work-scope"),
        title: "Dev server, then a build",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      // Turn 1 leaves a dev server running on purpose.
      yield* run(1, "completed");
      yield* command("dev", 1, 11, "running");

      // Turn 2 ended without a command of its own: its wait has nothing to hold.
      yield* run(2, "completed");
      const nothing = yield* Effect.flip(hold("hold-turn-2-empty"));
      assert.equal(nothing._tag, "OrchestratorCommandRejectedError");

      // Its build shows up after the turn ended; Wait from the banner takes it alone.
      yield* command("build", 2, 21, "running");
      yield* hold("hold-turn-2");
      assert.deepEqual(yield* heldIds, ["build"]);
      const waiting = yield* shellTasks;
      assert.deepEqual(
        waiting.map((task) => [task.taskId, task.kind === "command" && task.held === true]),
        [
          ["dev", false],
          ["build", true],
        ],
      );
      assert.isTrue(backgroundWorkHoldsCompletion(waiting));
      // Waiting again adds nothing, so it fails rather than claim a new wait.
      const repeated = yield* Effect.flip(hold("hold-turn-2-again"));
      assert.equal(repeated._tag, "OrchestratorCommandRejectedError");

      // Turn 3 is live. Before its test run registers, the held build alone
      // does not make its wait succeed.
      yield* run(3, "running");
      const early = yield* Effect.flip(hold("hold-turn-3-early"));
      assert.equal(early._tag, "OrchestratorCommandRejectedError");
      assert.deepEqual(yield* heldIds, ["build"]);

      // Its test run registers; the build already held stays held.
      yield* command("test", 3, 31, "running");
      yield* hold("hold-turn-3");
      assert.deepEqual(yield* heldIds, ["build", "test"]);

      // Both finish while the dev server runs on: the thread stops waiting.
      yield* command("build", 2, 21, "completed");
      yield* command("test", 3, 31, "completed");
      yield* run(3, "completed", "run.updated");
      const tasks = yield* shellTasks;
      assert.deepEqual(
        tasks.map((task) => task.taskId),
        ["dev"],
      );
      assert.isFalse(backgroundWorkHoldsCompletion(tasks));
    }),
  );
});
