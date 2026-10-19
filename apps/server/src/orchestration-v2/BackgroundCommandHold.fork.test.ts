import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  awaitBackgroundCommandToHold,
  BACKGROUND_COMMAND_REGISTRATION_WAIT,
} from "./BackgroundCommandHold.fork.ts";
import * as EventSink from "./EventSink.ts";
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
  openSession: () => Effect.die("No provider process needed for background command holds"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "background-command-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.layer(testLayer)("awaitBackgroundCommandToHold", (it) => {
  const runStartedAt = DateTime.makeUnsafe(1_000);
  // A live turn on a fresh thread. `roster` commits a Claude provider-thread
  // roster listing `tasks`; `commandItem` commits a running command item.
  const liveTurn = (name: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`thread:${name}`);
      const runId = RunId.make(`run:${name}`);
      const nodeId = NodeId.make(`node:${name}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create-${name}`),
        threadId,
        projectId: ProjectId.make("project:background-command-hold"),
        title: name,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${name}:run`),
            type: "run.created",
            threadId,
            runId,
            occurredAt: runStartedAt,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${name}`),
              rootNodeId: nodeId,
              activeAttemptId: null,
              status: "running",
              requestedAt: runStartedAt,
              startedAt: runStartedAt,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      const roster = (tasks: ReadonlyArray<{ readonly taskId: string; readonly at: number }>) =>
        sink.write({
          events: [
            {
              id: EventId.make(`event:${name}:roster:${tasks.length}`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: runStartedAt,
              payload: {
                id: ProviderThreadId.make(`provider-thread:${name}`),
                driver: CLAUDE_PROVIDER,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: tasks.map((task) => ({
                  taskId: task.taskId,
                  kind: "command" as const,
                  startedAt: DateTime.formatIso(DateTime.makeUnsafe(task.at)),
                })),
                contextUsage: null,
                nativeMetadata: null,
                goal: null,
                createdAt: runStartedAt,
                updatedAt: runStartedAt,
              },
            },
          ],
        });
      const commandItem = (itemId: string, at: number) =>
        sink.write({
          events: [
            {
              id: EventId.make(`event:${name}:item:${itemId}`),
              type: "turn-item.updated",
              threadId,
              runId,
              nodeId,
              driver,
              occurredAt: DateTime.makeUnsafe(at),
              payload: {
                id: TurnItemId.make(itemId),
                threadId,
                runId,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "running",
                title: itemId,
                startedAt: DateTime.makeUnsafe(at),
                completedAt: null,
                updatedAt: DateTime.makeUnsafe(at),
                type: "command_execution",
                input: itemId,
                output: "",
              },
            },
          ],
        });
      const hold = orchestrator.dispatch({
        type: "thread.background-work.hold",
        commandId: CommandId.make(`hold-${name}`),
        threadId,
        held: true,
      });
      // The MCP tool's order: wait for a command, then hold once.
      const waitThenHold = awaitBackgroundCommandToHold(orchestrator, threadId).pipe(
        Effect.andThen(hold),
      );
      const heldIds = Effect.map(
        orchestrator.getThreadProjection(threadId),
        (projection) => projection.thread.heldBackgroundTaskIds,
      );
      return { roster, commandItem, waitThenHold, heldIds };
    });

  it.effect("waits for a command that registers after the call, then holds it", () =>
    Effect.gen(function* () {
      const turn = yield* liveTurn("race");
      const waiting = yield* Effect.forkChild(turn.waitThenHold);
      // Short of the bound, nothing has registered: still waiting.
      yield* TestClock.adjust("1 second");
      assert.isUndefined(waiting.pollUnsafe());

      // The roster update the Bash start produces commits after the call.
      yield* turn.roster([{ taskId: "bash-build", at: 1_500 }]);
      yield* Fiber.join(waiting);
      assert.deepEqual(yield* turn.heldIds, ["bash-build"]);
    }),
  );

  it.effect("keeps waiting past Claude's running Bash item for the shell it starts", () =>
    Effect.gen(function* () {
      const turn = yield* liveTurn("claude-bash-item");
      // A Claude provider thread, and the Bash call still running as an item.
      yield* turn.roster([]);
      yield* turn.commandItem("toolu-build", 1_400);
      const waiting = yield* Effect.forkChild(turn.waitThenHold);
      yield* TestClock.adjust("1 second");
      assert.isUndefined(waiting.pollUnsafe());

      yield* turn.roster([{ taskId: "bash-build", at: 1_500 }]);
      yield* Fiber.join(waiting);
      assert.include((yield* turn.heldIds) ?? [], "bash-build");
    }),
  );

  it.effect("counts a running command item when the provider keeps no roster", () =>
    Effect.gen(function* () {
      const turn = yield* liveTurn("codex-item");
      yield* turn.commandItem("item-build", 1_400);
      // No clock adjustment: the first read finds it.
      yield* turn.waitThenHold;
      assert.deepEqual(yield* turn.heldIds, ["item-build"]);
    }),
  );

  it.effect("gives up at the bound when nothing new registers, and the hold rejects", () =>
    Effect.gen(function* () {
      const turn = yield* liveTurn("nothing");
      // A roster entry from before this run started is not this turn's.
      yield* turn.roster([{ taskId: "bash-dev-server", at: 500 }]);
      const waiting = yield* Effect.forkChild(Effect.flip(turn.waitThenHold));
      yield* TestClock.adjust("1 second");
      assert.isUndefined(waiting.pollUnsafe());

      yield* TestClock.adjust(BACKGROUND_COMMAND_REGISTRATION_WAIT);
      const rejected = yield* Fiber.join(waiting);
      assert.equal(rejected._tag, "OrchestratorCommandRejectedError");
    }),
  );

  it.effect("returns at once when the command is already visible", () =>
    Effect.gen(function* () {
      const turn = yield* liveTurn("visible");
      yield* turn.roster([{ taskId: "bash-test", at: 1_200 }]);
      yield* turn.waitThenHold;
      assert.deepEqual(yield* turn.heldIds, ["bash-test"]);
    }),
  );
});
