// Fork tests for ThreadTitleRegenerationService.test.ts.
import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapterV2Shape;

function makeHarness(options: { readonly generateThreadTitles?: boolean } = {}) {
  const database = SqlitePersistence.layerMemory;
  const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const orchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-regeneration" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const generateThreadTitle = vi.fn<
    TextGeneration.TextGeneration["Service"]["generateThreadTitle"]
  >(() => Effect.succeed({ title: "Generated title" }));
  const projectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threadManagement,
        projectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        ServerSettings.layerTest(
          // Fork: the automatic-titles toggle.
          options.generateThreadTitles === undefined
            ? {}
            : { generateThreadTitles: options.generateThreadTitles },
        ),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(threadManagement, titleRegeneration, outbox, database),
    generateThreadTitle,
  };
}

function createThread(input: { readonly command: string; readonly thread: string }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
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
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

describe("ThreadTitleRegenerationService", () => {
  // Fork: the generateThreadTitles setting stops the first-turn title only.
  it.effect("keeps the seed title when automatic titles are off, but still regenerates", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ generateThreadTitles: false });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:off:create",
          thread: "thread:title:off",
        });
        yield* dispatchUserMessage({
          command: "command:title:off:message",
          threadId,
          text: "Investigate the flaky login test",
        });
        const initialRequest = yield* armRegeneration({ command: "command:title:off:1", threadId });
        yield* titleRegeneration.execute({
          threadId,
          requestId: initialRequest,
          kind: { type: "initial", messageId: MessageId.make("command:title:off:message:message") },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const afterInitial = yield* threads.getThreadProjection(threadId);
        assert.equal(afterInitial.thread.title, "Seed title");
        assert.isNotOk(afterInitial.thread.titleRegeneration);

        const regenerateRequest = yield* armRegeneration({
          command: "command:title:off:2",
          threadId,
        });
        yield* titleRegeneration.execute({
          threadId,
          requestId: regenerateRequest,
          kind: { type: "regenerate" },
        });
        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const afterRegenerate = yield* threads.getThreadProjection(threadId);
        assert.equal(afterRegenerate.thread.title, "Generated title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
