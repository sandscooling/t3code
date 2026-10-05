import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

// Fork: a scheduled task bound to a thread queues behind that thread's running
// turn instead of steering into it, on a real v2 orchestrator. Provider
// processes never start, so a turn stays running until a test ends it.

const projectId = ProjectId.make("project:scheduled-fork");
const codex = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: codex, model: "gpt-5.5" };

const adapter = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider processes never start in these tests"),
} as ProviderAdapterV2Shape;

const makeHarness = () => {
  const database = SqlitePersistenceMemory;
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "scheduled-fork" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  // Merged so a test can write provider events through the real event sink.
  const threadManagement = ThreadManagement.layer.pipe(Layer.provideMerge(orchestrator));
  const scheduledTasks = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threadManagement,
        database,
        // Only an unbound task launches a thread.
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );
  return Layer.mergeAll(scheduledTasks, threadManagement);
};

const createThread = (id: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(id);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:create:${id}`),
      threadId,
      projectId,
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

/** Puts a steerable turn on an idle thread, as a provider mid-turn leaves it. */
const runningTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`run:${threadId}`);
    const attemptId = RunAttemptId.make(`attempt:${threadId}`);
    const nodeId = NodeId.make(`node:${threadId}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${threadId}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: codex,
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
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`${threadId}:run`),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: codex,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:${threadId}`),
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${threadId}:attempt`),
          type: "run-attempt.created",
          threadId,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId: codex,
            providerThreadId,
            providerTurnId: ProviderTurnId.make(`provider-turn:${threadId}`),
            reason: "initial",
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:turn`),
          type: "provider-turn.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make(`provider-turn:${threadId}`),
            providerThreadId,
            nodeId,
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    return runId;
  });

const runBoundTask = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const { task } = yield* tasks.upsert({
      id: ScheduledTaskId.make(`scheduled-task:${threadId}`),
      title: "Upstream sync",
      prompt: "Sync with upstream.",
      enabled: false,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId,
      threadId,
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
    });
    // A due run and a manual one take the same dispatch path.
    return (yield* tasks.runNow({ id: task.id })).task;
  });

it.effect("queues a bound task behind the thread's running turn, which then starts it", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = yield* createThread("thread:busy");
    const activeRunId = yield* runningTurn(threadId);

    // A steer here would need the turn's live provider session, which no
    // process provides, so the run would fail instead of succeeding.
    const ran = yield* runBoundTask(threadId);
    assert.equal(ran.lastRunStatus, "succeeded");
    const queued = yield* threads.getThreadProjection(threadId);
    assert.deepEqual(
      queued.runs.map((run) => [run.id === activeRunId, run.status]),
      [
        [true, "running"],
        [false, "queued"],
      ],
    );
    assert.deepEqual(
      queued.providerTurns.map((turn) => turn.status),
      ["running"],
    );
    const scheduledRun = queued.runs.find((run) => run.id !== activeRunId)!;
    assert.equal(
      queued.messages.find((message) => message.id === scheduledRun.userMessageId)?.scheduledTaskId,
      ran.id,
    );

    // The turn ends, and the queue starts the scheduled run.
    const activeRun = queued.runs.find((run) => run.id === activeRunId)!;
    const afterSequence = yield* sink.latestSequence({ threadId });
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${threadId}:run-completed`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...activeRun, status: "completed", completedAt: now },
        },
      ],
    });
    const promoted = yield* sink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" && stored.event.payload.id === scheduledRun.id,
      ),
      Stream.runHead,
    );
    assert.isTrue(Option.isSome(promoted));
    const started = yield* threads.getThreadProjection(threadId);
    assert.notEqual(started.runs.find((run) => run.id === scheduledRun.id)?.status, "queued");
  }).pipe(Effect.provide(makeHarness())),
);

it.effect("starts a bound task's run at once on an idle thread", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* createThread("thread:idle");

    const ran = yield* runBoundTask(threadId);
    assert.equal(ran.lastRunStatus, "succeeded");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.runs.length, 1);
    assert.notEqual(projection.runs[0]?.status, "queued");
    assert.equal(
      projection.messages.find((message) => message.id === projection.runs[0]?.userMessageId)
        ?.scheduledTaskId,
      ran.id,
    );
  }).pipe(Effect.provide(makeHarness())),
);
