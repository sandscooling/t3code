import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// Run 1 settles, optionally leaving a command running. Run 2's provider start
// is refused, the way Claude refuses a query swap while background work runs,
// so it fails with no provider turn of its own. Then Stop targets run 2.
const stopAfterRefusedRun = (input: {
  readonly name: string;
  readonly leaveBackgroundWork: boolean;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(input.name);
      const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const interrupts: ProviderAdapterV2InterruptInput[] = [];
      let startCount = 0;
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (session) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: session.providerSessionId,
              providerSession: {
                id: session.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: session.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  startCount += 1;
                  if (startCount > 1) {
                    return yield* new ProviderAdapterTurnStartError({
                      driver,
                      threadId: turn.threadId,
                      providerThreadId: turn.providerThread.id,
                      runId: turn.runId,
                    });
                  }
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (interrupt) =>
                Effect.sync(() => {
                  interrupts.push(interrupt);
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`thread:${input.name}`);
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const sendMessage = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make(`project:${input.name}`),
          title: "Stop after a refused run",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* sendMessage("start-dev-server");
        yield* worker.drain();
        yield* Fiber.join(running);
        const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const firstTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const now = yield* DateTime.now;
        if (input.leaveBackgroundWork) {
          yield* sink.write({
            events: [
              {
                id: EventId.make("dev-server"),
                type: "turn-item.updated",
                threadId,
                runId: firstRun.id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("turn-item:dev-server"),
                  threadId,
                  runId: firstRun.id,
                  nodeId: firstTurn.nodeId,
                  providerThreadId: firstTurn.providerThreadId,
                  providerTurnId: firstTurn.id,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 100,
                  status: "running",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "command_execution",
                  input: "vp run dev --share",
                },
              },
            ],
          });
        }
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === firstRun.id &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...firstTurn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: firstTurn.providerThreadId,
          providerTurnId: firstTurn.id,
          runOrdinal: firstRun.ordinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const refused = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.ordinal === 2 &&
            event.payload.status === "failed",
        );
        yield* sendMessage("refused-message");
        yield* worker.drain();
        yield* Fiber.join(refused);
        yield* worker.drain();
        const refusedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;

        const stop = orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: refusedRun.id,
        });
        if (!input.leaveBackgroundWork) {
          const stopError = yield* Effect.flip(stop);
          return { stopError, interrupts, firstTurn, refusedRun, devServerStatus: undefined };
        }
        yield* stop;
        yield* worker.drain();
        const devServerStatus = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (item) => item.id === TurnItemId.make("turn-item:dev-server"),
        )?.status;
        return { stopError: undefined, interrupts, firstTurn, refusedRun, devServerStatus };
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: input.name },
            ProviderAdapterRegistry.makeSingleLayer(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );

it.effect("Stop on a refused run reaches the background work an earlier turn left", () =>
  Effect.gen(function* () {
    const { interrupts, firstTurn, refusedRun, devServerStatus } = yield* stopAfterRefusedRun({
      name: "refused-run-stop",
      leaveBackgroundWork: true,
    });
    assert.strictEqual(refusedRun.status, "failed");
    assert.deepEqual(
      interrupts.map((interrupt) => [interrupt.providerThread.id, interrupt.providerTurnId]),
      [[firstTurn.providerThreadId, firstTurn.id]],
    );
    assert.strictEqual(refusedRun.providerThreadId, firstTurn.providerThreadId);
    // The settle is what clears the Waiting strip.
    assert.strictEqual(devServerStatus, "interrupted");
  }),
);

it.effect("Stop on a refused run with no background work is still not interruptible", () =>
  Effect.gen(function* () {
    const { stopError, interrupts, refusedRun } = yield* stopAfterRefusedRun({
      name: "refused-run-no-work",
      leaveBackgroundWork: false,
    });
    assert.strictEqual(refusedRun.status, "failed");
    assert.strictEqual(stopError?._tag, "OrchestratorDispatchError");
    assert.strictEqual(
      stopError?._tag === "OrchestratorDispatchError" ? stopError.cause : undefined,
      `Run ${refusedRun.id} is not interruptible.`,
    );
    assert.deepEqual(interrupts, []);
  }),
);
