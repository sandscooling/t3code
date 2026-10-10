// The fork's tests for ClaudeAdapterV2.test.ts.
import * as NodeOS from "node:os";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ProviderReplayTranscript,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../../config.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../testkit/DeterministicRuntime.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "../testkit/fixtures/shared.ts";

// Fixtures and wake harness copied (trimmed) from ClaudeAdapterV2.test.ts.
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
}): ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 runtime query policy", () => {
  // Fork: per-thread output style rides this thread's session-scoped settings.
  it("forwards the selected output style into SDK settings", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        ...CLAUDE_TEST_MODEL_SELECTION,
        options: [{ id: "outputStyle", value: "Explanatory" }],
      },
      nativeThreadId: "output-style-thread",
      resume: false,
      cwd: "/workspace",
    });
    // Other settings (thinking summaries) share this object.
    assert.include(options.settings, { outputStyle: "Explanatory", showThinkingSummaries: true });
  });

  // Fork: "default" is the CLI zero state; forwarding it would pin a style.
  it("sends the default output style as absence rather than a value", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        ...CLAUDE_TEST_MODEL_SELECTION,
        options: [{ id: "outputStyle", value: "default" }],
      },
      nativeThreadId: "output-style-thread",
      resume: false,
      cwd: "/workspace",
    });
    assert.notProperty(options.settings ?? {}, "outputStyle");
  });
});

describe("ClaudeAdapterV2 background wake turns", () => {
  const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

  function claudeSdkFrame(frame: unknown): SDKMessage {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof Reflect.get(frame, "type") !== "string"
    ) {
      throw new Error("Frame is not a Claude Agent SDK message.");
    }
    return frame as SDKMessage;
  }

  const makeResultFrame = (input: { readonly uuid: string; readonly result: string }) =>
    claudeSdkFrame({
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: false,
      num_turns: 1,
      result: input.result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
      terminal_reason: "completed",
    });

  const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 5000; attempt++) {
        if (predicate()) {
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(`Timed out waiting for ${label}.`);
    });

  const makeWakeHarness = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(sdkMessages, message);
      yield* Deferred.await(processed);
    });
    const terminalReceipts =
      yield* Queue.unbounded<Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>>();
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      crypto: yield* Crypto.Crypto,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      idAllocator,
      continuationRequests: { offer: () => Effect.void },
      queryRunner: {
        allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
        open: () =>
          Effect.sync(() => ({
            messages: Stream.fromQueue(sdkMessages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  // The next pull happens after runForEach finishes handling this frame.
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        const processed = processedMessages.get(message);
                        return processed === undefined
                          ? Effect.void
                          : Deferred.succeed(processed, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
            offer: () => Effect.void,
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          })),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
        }),
      ),
      Effect.forkScoped,
    );
    const terminalEvents = () =>
      events.filter(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      offerAndWait,
      events,
      terminalReceipts,
      terminalEvents,
    };
  });

  const providerThreadRosterEvents = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
    events.filter(
      (event): event is Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }> =>
        event.type === "provider_thread.updated",
    );

  type TaskToolCall =
    | { name: "TaskCreate"; input: TaskCreateInput; output: TaskCreateOutput }
    | { name: "TaskUpdate"; input: TaskUpdateInput; output: TaskUpdateOutput }
    | { name: "TaskList"; input: Record<string, never>; output: TaskListOutput };

  function taskToolFrames(
    tool: TaskToolCall,
    nextUuid: () => string,
    options?: { parentToolUseId?: string; isError?: boolean; extraToolResult?: boolean },
  ): ReadonlyArray<SDKMessage> {
    const uuid = nextUuid();
    const toolUseId = `tool-${uuid}`;
    const parentToolUseId = options?.parentToolUseId ?? null;
    return [
      claudeSdkFrame({
        type: "assistant",
        message: {
          id: `msg_${uuid}`,
          model: "claude-sonnet-4-6",
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: toolUseId, name: tool.name, input: tool.input }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: parentToolUseId,
        uuid,
        session_id: WAKE_NATIVE_SESSION,
      }),
      claudeSdkFrame({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: "Task tool finished.",
              is_error: options?.isError ?? false,
            },
            ...(options?.extraToolResult
              ? [{ type: "tool_result", tool_use_id: "unrelated-tool", content: "ok" }]
              : []),
          ],
        },
        tool_use_result: tool.output,
        parent_tool_use_id: parentToolUseId,
        uuid: nextUuid(),
        session_id: WAKE_NATIVE_SESSION,
      }),
    ];
  }

  const makeTaskToolHarness = Effect.gen(function* () {
    const harness = yield* makeWakeHarness;
    let sequence = 600;
    let turn = 0;
    const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const startTurn = Effect.fnUntraced(function* () {
      turn++;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`attempt-claude-task-tools-${turn}`),
          providerTurnOrdinal: turn,
          text: "Update the task list.",
          attachments: [],
        }),
      );
    });
    const call = Effect.fnUntraced(function* (
      tool: TaskToolCall,
      options?: { parentToolUseId?: string; isError?: boolean; extraToolResult?: boolean },
    ) {
      for (const frame of taskToolFrames(tool, nextUuid, options)) {
        yield* harness.offerAndWait(frame);
      }
    });
    const finishTurn = Effect.fnUntraced(function* () {
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: nextUuid(), result: "Task list updated." }),
      );
      yield* Queue.take(harness.terminalReceipts);
    });
    const plans = () =>
      harness.events.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
    return { startTurn, call, finishTurn, plans };
  });

  const createTask = (id: string, subject: string): TaskToolCall => ({
    name: "TaskCreate",
    input: { subject: `Requested ${subject}`, description: `Work on ${subject}.` },
    output: { task: { id, subject } },
  });
  const updateTask = (input: TaskUpdateInput, success = true): TaskToolCall => ({
    name: "TaskUpdate",
    input,
    output: { success, taskId: input.taskId, updatedFields: ["status"] },
  });

  it.effect("persists a todo_list from inline Claude task-tool frames", () =>
    Effect.gen(function* () {
      let sequence = 700;
      const nextUuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      const prompt = "Track a synthetic task.";
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
        provider: "claudeAgent",
        protocol: "claude-agent-sdk.query",
        version: "1",
        scenario: "claude_task_tools_inline",
        metadata: { nativeSessionId: WAKE_NATIVE_SESSION },
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: {
                model: "claude-sonnet-4-6",
                tools: { type: "preset", preset: "claude_code" },
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                settings: { showThinkingSummaries: true },
                sessionId: WAKE_NATIVE_SESSION,
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "prompt.offer",
              message: {
                type: "user",
                message: { role: "user", content: prompt },
                parent_tool_use_id: null,
              },
            },
          },
          ...[
            ...taskToolFrames(createTask("1", "Inspect"), nextUuid),
            ...taskToolFrames(updateTask({ taskId: "1", status: "in_progress" }), nextUuid),
            makeResultFrame({ uuid: nextUuid(), result: "Task recorded." }),
          ].map((frame) => ({ type: "emit_inbound" as const, frame })),
        ],
      } satisfies ProviderReplayTranscript);
      const materialized = yield* materializeFixtureInput({
        scenario: transcript.scenario,
        fixtureInput: { steps: [{ type: "message", text: prompt }] },
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
      const scenario = { name: transcript.scenario, transcript, ...materialized };
      yield* Effect.gen(function* () {
        const result = yield* runOrchestratorV2Scenario(scenario);
        assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
        const projection = projectionFor(result, transcript.scenario);
        assertSemanticProjectionIntegrity(projection);
        const plans = projection.plans.filter((plan) => plan.kind === "todo_list");
        assert.lengthOf(plans, 1);
        assert.deepEqual(
          plans[0]?.steps.map(({ id, text, status }) => ({ id, text, status })),
          [{ id: "task-1", text: "Inspect", status: "running" }],
        );
        assert.lengthOf(
          projection.turnItems.filter((item) => item.type === "todo_list"),
          1,
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerProviderReplay(scenario, ClaudeOrchestratorReplayHarness),
        ),
        provideDeterministicTestRuntime,
        Effect.scoped,
      );
    }),
  );

  it.effect(
    "projects TaskCreate and TaskUpdate into one plan per turn and supersedes it later",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeTaskToolHarness;
        yield* harness.startTurn();
        yield* harness.call(createTask("1", "Inspect"));
        yield* harness.call(createTask("2", "Implement"));
        yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
        yield* harness.finishTurn();

        const firstTurnPlans = harness.plans();
        assert.lengthOf(firstTurnPlans, 3);
        assert.equal(new Set(firstTurnPlans.map((plan) => plan.id)).size, 1);
        assert.deepEqual(firstTurnPlans.at(-1)?.steps, [
          { id: "task-1", text: "Inspect", status: "running" },
          { id: "task-2", text: "Implement", status: "pending" },
        ]);
        const firstPlan = firstTurnPlans.at(-1)!;

        yield* harness.startTurn();
        yield* harness.call(updateTask({ taskId: "1", status: "completed", subject: "Inspected" }));
        yield* harness.finishTurn();

        const laterPlans = harness.plans().slice(firstTurnPlans.length);
        assert.lengthOf(laterPlans, 2);
        assert.equal(laterPlans[0]?.id, firstPlan.id);
        assert.equal(laterPlans[0]?.status, "superseded");
        const newPlan = laterPlans[1]!;
        assert.notEqual(newPlan.id, firstPlan.id);
        assert.notEqual(newPlan.runId, firstPlan.runId);
        assert.deepEqual(newPlan.steps, [
          { id: "task-1", text: "Inspected", status: "completed" },
          { id: "task-2", text: "Implement", status: "pending" },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("removes deleted tasks without resurrecting them on later updates or turns", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Discard"));
      yield* harness.call(createTask("2", "Keep"));
      yield* harness.call(updateTask({ taskId: "1", status: "deleted" }));
      yield* harness.call(updateTask({ taskId: "1", status: "pending" }));
      yield* harness.finishTurn();
      assert.lengthOf(harness.plans(), 3);
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-2", text: "Keep", status: "pending" },
      ]);

      yield* harness.startTurn();
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }));
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-2", text: "Keep", status: "running" },
      ]);
      for (const plan of harness.plans().slice(2)) {
        assert.isFalse(plan.steps.some((step) => step.id === "task-1"));
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect.each(["success false", "error result", "unknown id"] as const)(
    "does not emit a plan update for TaskUpdate with %s",
    (reason) =>
      Effect.gen(function* () {
        const harness = yield* makeTaskToolHarness;
        yield* harness.startTurn();
        yield* harness.call(createTask("1", "Inspect"));
        yield* harness.call(
          updateTask(
            { taskId: reason === "unknown id" ? "missing" : "1", status: "completed" },
            reason !== "success false",
          ),
          { isError: reason === "error result" },
        );
        yield* harness.finishTurn();
        assert.lengthOf(harness.plans(), 1);
        assert.deepEqual(harness.plans()[0]?.steps, [
          { id: "task-1", text: "Inspect", status: "pending" },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("replaces task state with TaskList, including an empty list", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Stale"));
      yield* harness.call({
        name: "TaskList",
        input: {},
        output: {
          tasks: [
            { id: "2", subject: "Queued", status: "pending", blockedBy: [] },
            { id: "3", subject: "Working", status: "in_progress", blockedBy: [] },
            { id: "4", subject: "Done", status: "completed", blockedBy: [] },
          ],
        },
      });
      yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
      yield* harness.call(updateTask({ taskId: "2", status: "in_progress" }));
      yield* harness.call({ name: "TaskList", input: {}, output: { tasks: [] } });
      yield* harness.call(updateTask({ taskId: "2", status: "pending" }));
      yield* harness.finishTurn();
      const plans = harness.plans();
      assert.lengthOf(plans, 4);
      assert.deepEqual(plans[1]?.steps, [
        { id: "task-2", text: "Queued", status: "pending" },
        { id: "task-3", text: "Working", status: "running" },
        { id: "task-4", text: "Done", status: "completed" },
      ]);
      assert.deepEqual(plans[2]?.steps, [
        { id: "task-2", text: "Queued", status: "running" },
        { id: "task-3", text: "Working", status: "running" },
        { id: "task-4", text: "Done", status: "completed" },
      ]);
      assert.deepEqual(plans[3]?.steps, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("keeps subagent TaskCreate, TaskUpdate and TaskList out of the main plan", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Main task"));
      const child = { parentToolUseId: "tool-parent-agent" };
      yield* harness.call(createTask("2", "Child task"), child);
      yield* harness.call(updateTask({ taskId: "1", status: "completed" }), child);
      yield* harness.call({ name: "TaskList", input: {}, output: { tasks: [] } }, child);
      yield* harness.call(updateTask({ taskId: "1", status: "in_progress" }));
      yield* harness.finishTurn();
      assert.lengthOf(harness.plans(), 2);
      assert.deepEqual(harness.plans().at(-1)?.steps, [
        { id: "task-1", text: "Main task", status: "running" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect("does not associate structured task output with multiple tool results", () =>
    Effect.gen(function* () {
      const harness = yield* makeTaskToolHarness;
      yield* harness.startTurn();
      yield* harness.call(createTask("1", "Ambiguous"), { extraToolResult: true });
      yield* harness.finishTurn();
      assert.deepEqual(harness.plans(), []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  // Fork: a client shows how long background work has run from startedAt.
  it.effect("keeps a background task's first start time when Claude resends the roster", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const startedAt = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: startedAt,
            attemptId: RunAttemptId.make("attempt-claude-roster-started-at"),
            text: "Start the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-build",
            tool_use_id: "toolu-build",
            description: "build",
            is_backgrounded: true,
            task_type: "local_bash",
            uuid: "00000000-0000-4000-8000-000000000701",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(harness.events).some((event) =>
              (event.providerThread.pendingBackgroundTasks ?? []).some(
                (task) => task.taskId === "task-build",
              ),
            ),
          "build task on the roster",
        );
        yield* TestClock.adjust("5 minutes");
        const laterAt = yield* DateTime.now;
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              { task_id: "task-build", task_type: "local_bash", description: "build" },
              { task_id: "task-tests", task_type: "local_bash", description: "tests" },
            ],
            uuid: "00000000-0000-4000-8000-000000000702",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000703", result: "Running." }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");

        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(
          roster?.map((task) => [task.taskId, task.startedAt]),
          [
            ["task-build", DateTime.formatIso(startedAt)],
            ["task-tests", DateTime.formatIso(laterAt)],
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

// Upstream's captureSdkExecutablePaths from ClaudeAdapterV2.test.ts, plus an
// environment parameter and the CLAUDE_CODE_ENABLE_TODO_TOOLS value the SDK was given.
const captureSdkExecutablePaths = Effect.fn("captureSdkExecutablePaths")(function* (
  binaryPath: string,
  environment: ProviderInstanceEnvironment = [],
) {
  const executablePaths: Array<string | undefined> = [];
  const taskToolEnvironment: Array<string | undefined> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath },
    },
    {},
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-claude-binary-path-",
      }),
    ),
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-claude-binary-path"),
      open: (input) =>
        Effect.sync(() => {
          executablePaths.push(input.options.pathToClaudeCodeExecutable);
          taskToolEnvironment.push(input.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    }),
  );
  const threadId = ThreadId.make("thread-claude-binary-path");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-binary-path"),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  yield* runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId,
      providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-binary-path"),
      text: "hello",
      attachments: [],
    }),
  );
  return { executablePaths, taskToolEnvironment };
});

describe("ClaudeAdapterV2 executable path", () => {
  it.effect.each([
    { source: "default", environment: [], hostEnvironment: {}, expected: "1" },
    {
      source: "instance opt-out",
      environment: [{ name: "CLAUDE_CODE_ENABLE_TODO_TOOLS", value: "0", sensitive: false }],
      hostEnvironment: {},
      expected: "0",
    },
    {
      source: "host opt-out",
      environment: [],
      hostEnvironment: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "0" },
      expected: "0",
    },
  ])("expands the executable path and respects $source for task tools", (testCase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { executablePaths, taskToolEnvironment } = yield* captureSdkExecutablePaths(
          "~/bin/claude",
          testCase.environment,
        );

        assert.deepEqual(executablePaths, [path.join(NodeOS.homedir(), "bin", "claude")]);
        assert.deepEqual(taskToolEnvironment, [testCase.expected]);
      }),
    ).pipe(
      Effect.provideService(HostProcess.Environment, testCase.hostEnvironment),
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});
