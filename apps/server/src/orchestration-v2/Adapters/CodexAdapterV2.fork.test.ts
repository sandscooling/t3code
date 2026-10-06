// The fork's tests for CodexAdapterV2.test.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

// Replay harness copied (trimmed) from CodexAdapterV2.test.ts.
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
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

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

describe("CodexAdapterV2 post-settle continuation", () => {
  const makeCodexReplayHarness = (transcript: CodexReplay.CodexAppServerReplayTranscript) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
      const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.map((client) => withCodexReplayChildMetadata(client, transcript)),
                Effect.provide(context),
              ),
            ),
          ),
      };
      const adapter = CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        crypto: yield* Crypto.Crypto,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory,
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: { offer: () => Effect.void },
      });
      const threadId = ThreadId.make(`thread-${transcript.scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapterV2Event> = [];
      const firstTerminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.terminal"
                ? Deferred.succeed(firstTerminal, undefined)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return {
        runtime,
        providerThread,
        threadId,
        events,
        firstTerminal: Deferred.await(firstTerminal),
      };
    });

  // Fork: generated images reach the work log through viewedImagePath.
  const IMAGE_NATIVE_THREAD = "native-codex-image-thread";
  const IMAGE_NATIVE_TURN = "native-codex-image-turn";
  const IMAGE_PROMPT = "Draw a cooling fan.";
  const IMAGE_SAVED_PATH = "/home/user/.codex/generated_images/fan.png";
  const imageGenerationTranscript = (savedPath: string | null) =>
    makeCodexReplayTranscript({
      scenario: "codex-image-generation",
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: IMAGE_NATIVE_THREAD,
          nativeTurnId: IMAGE_NATIVE_TURN,
          prompt: IMAGE_PROMPT,
        }),
        {
          type: "emit_inbound",
          label: "item/completed/image-generation",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "imageGeneration",
                id: "ig-fan",
                status: "completed",
                result: "",
                revisedPrompt: "A cooling fan, line art",
                savedPath,
              },
              threadId: IMAGE_NATIVE_THREAD,
              turnId: IMAGE_NATIVE_TURN,
              completedAtMs: 1782622441500,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: IMAGE_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: IMAGE_NATIVE_TURN, status: "completed" }),
            },
          },
        },
      ],
    });
  const runImageGenerationTurn = (savedPath: string | null) =>
    Effect.gen(function* () {
      const harness = yield* makeCodexReplayHarness(imageGenerationTranscript(savedPath));
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-codex-image-generation"),
          text: IMAGE_PROMPT,
        }),
      );
      yield* harness.firstTerminal;
      return harness.events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.nativeItemRef?.nativeId === "ig-fan"
          ? [event.turnItem]
          : [],
      );
    });

  it.effect("records a generated image as a dynamic tool row carrying its saved path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const items = yield* runImageGenerationTurn(IMAGE_SAVED_PATH);
        assert.lengthOf(items, 1);
        assert.equal(items[0]?.toolName, "image_generation");
        assert.equal(items[0]?.title, "Generated image");
        assert.equal(items[0]?.viewedImagePath, IMAGE_SAVED_PATH);
        assert.equal(items[0]?.status, "completed");
        assert.deepEqual(items[0]?.input, { prompt: "A cooling fan, line art" });
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("records nothing for a generated image that was never saved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const items = yield* runImageGenerationTurn(null);
        assert.lengthOf(items, 0);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  // Fork: an image Codex viewed reaches the work log the same way.
  const IMAGE_VIEW_PATH = "/workspace/assets/fan.png";
  it.effect("records a viewed image as a dynamic tool row carrying its path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-image-view",
            entries: [
              ...codexReplayPreamble({
                nativeThreadId: IMAGE_NATIVE_THREAD,
                nativeTurnId: IMAGE_NATIVE_TURN,
                prompt: IMAGE_PROMPT,
              }),
              {
                type: "emit_inbound",
                label: "item/completed/image-view",
                frame: {
                  method: "item/completed",
                  params: {
                    item: { type: "imageView", id: "iv-fan", path: IMAGE_VIEW_PATH },
                    threadId: IMAGE_NATIVE_THREAD,
                    turnId: IMAGE_NATIVE_TURN,
                    completedAtMs: 1782622441500,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: IMAGE_NATIVE_THREAD,
                    turn: makeCodexReplayTurn({ id: IMAGE_NATIVE_TURN, status: "completed" }),
                  },
                },
              },
            ],
          }),
        );
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-image-view"),
            text: IMAGE_PROMPT,
          }),
        );
        yield* harness.firstTerminal;
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "iv-fan"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(items, 1);
        assert.equal(items[0]?.toolName, "view_image");
        assert.equal(items[0]?.title, "Viewed image");
        assert.equal(items[0]?.viewedImagePath, IMAGE_VIEW_PATH);
        assert.equal(items[0]?.status, "completed");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
