import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CLAUDE_PROVIDER, ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "./ProviderContinuationRequests.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

// Fork: v1 closed a Claude turn the agent started on its own (a background
// task or peer wake) when the next message arrived, dismissing the question
// it was waiting on while the SDK callback kept waiting. On v2 that wake is a
// continuation run like any other; a message arriving mid-question steers it.

const driver = CLAUDE_PROVIDER;
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };

for (const delivery of ["auto", "steer"] as const) {
  it.effect(`keeps a wake turn's open question when a message arrives (${delivery})`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`fork-mid-wait-question-${delivery}`);
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const started: ProviderAdapterV2TurnInput[] = [];
        const steered: string[] = [];
        const interrupted: string[] = [];
        const responded: string[] = [];
        let continuation:
          | { readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void> }
          | undefined;

        const makeAdapter = Effect.gen(function* () {
          continuation = yield* ProviderContinuationRequests;
          const adapter: ProviderAdapterV2Shape = {
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: (input) =>
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                return {
                  instanceId,
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerSession: {
                    id: input.providerSessionId,
                    driver,
                    providerInstanceId: instanceId,
                    status: "ready",
                    cwd,
                    model: modelSelection.model,
                    capabilities: ClaudeProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  events: Stream.fromQueue(events),
                  ensureThread: ({ threadId }) =>
                    Effect.succeed({
                      id: ProviderThreadId.make(`provider-thread:${threadId}`),
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: input.providerSessionId,
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
                      started.push(turn);
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
                  steerTurn: (turn) => Effect.sync(() => void steered.push(turn.message.text)),
                  interruptTurn: (turn) =>
                    Effect.sync(() => void interrupted.push(String(turn.providerTurnId))),
                  respondToRuntimeRequest: (request) =>
                    Effect.sync(() => void responded.push(String(request.requestId))),
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                };
              }),
          };
          return [adapter];
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make(`thread:mid-wait-question-${delivery}`);
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );

          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:mid-wait-question"),
            title: "Mid-wait question",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });

          // A user turn runs and finishes.
          const firstRunning = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("message:first"),
            text: "Start the build in the background.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(firstRunning);
          const first = started[0]!;
          const firstSettled = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          );
          const firstTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...firstTurn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: first.providerThread.id,
            providerTurnId: ProviderTurnId.make(`provider-turn:${first.attemptId}`),
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(firstSettled);
          // Checkpoint capture completes the run.
          yield* worker.drain();

          // The agent wakes on its own: the adapter asks for a continuation run.
          const wakeRunCreated = yield* watch((event) => event.type === "run.created");
          const wakeRunning = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== first.attemptId,
          );
          yield* continuation!.offer({
            threadId,
            providerThreadId: first.providerThread.id,
            driver,
            detail: null,
          });
          yield* Fiber.join(wakeRunCreated);
          yield* worker.drain();
          yield* Fiber.join(wakeRunning);
          const wake = started[1]!;
          assert.equal(wake.message.creationSource, "provider", "a provider wake, not a user turn");
          const providerSessionId = wake.providerThread.providerSessionId!;

          // Inside the wake turn the agent asks the user a question.
          const now = yield* DateTime.now;
          const providerTurnId = ProviderTurnId.make(`provider-turn:${wake.attemptId}`);
          const requestId = RuntimeRequestId.make("request:mid-wait-question");
          const nodeId = NodeId.make("node:mid-wait-question");
          const questionPending = yield* watch(
            (event) =>
              event.type === "runtime-request.updated" &&
              event.payload.id === requestId &&
              event.payload.status === "pending",
          );
          yield* Queue.offerAll(events, [
            {
              type: "node.updated",
              driver,
              node: {
                id: nodeId,
                threadId,
                runId: wake.runId,
                parentNodeId: wake.rootNodeId,
                rootNodeId: wake.rootNodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: wake.providerThread.id,
                providerTurnId,
                nativeItemRef: { driver, nativeId: "ask-1", strength: "strong" },
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              type: "runtime_request.updated",
              driver,
              threadId,
              runtimeRequest: {
                id: requestId,
                nodeId,
                providerTurnId,
                nativeRequestRef: { driver, nativeId: "ask-1", strength: "strong" },
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "live", providerSessionId },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: TurnItemId.make("item:mid-wait-question"),
                threadId,
                runId: wake.runId,
                nodeId,
                providerThreadId: wake.providerThread.id,
                providerTurnId,
                nativeItemRef: { driver, nativeId: "ask-1", strength: "strong" },
                parentItemId: null,
                ordinal: 1,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "user_input_request",
                requestId,
                questions: [
                  {
                    id: "caps",
                    header: "Caps",
                    question: "Where should the caps go?",
                    options: [{ label: "F4", description: "The F4 row" }],
                  },
                ],
              },
            },
          ]);
          yield* Fiber.join(questionPending);

          // Another session's session_wake lands while the question waits.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("peer-wake"),
            threadId,
            messageId: MessageId.make("message:peer-wake"),
            text: "peer check-in",
            attachments: [],
            ...(delivery === "auto"
              ? { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }
              : { dispatchMode: { type: "steer_active", targetRunId: wake.runId } }),
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["peer check-in"], "the message steers the wake turn");
          assert.lengthOf(started, 2, "no new turn replaces the waiting one");
          assert.equal(projection.runs.find((run) => run.id === wake.runId)?.status, "running");
          assert.equal(
            projection.runtimeRequests.find((request) => request.id === requestId)?.status,
            "pending",
            "the question stays open",
          );
          assert.deepEqual(interrupted, []);
          assert.deepEqual(responded, []);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: `fork-mid-wait-question-${delivery}` },
              ProviderAdapterRegistry.makeLayerEffect(makeAdapter),
              { runEffectWorker: false, runContinuationWorker: true },
            ),
          ),
        );
      }),
    ),
  );
}
