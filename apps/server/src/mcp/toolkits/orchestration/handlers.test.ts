// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as ContextHandoffService from "../../../orchestration-v2/ContextHandoffService.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../../../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../../../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStart from "../../../orchestration-v2/ProviderTurnStartService.ts";
import * as RunExecutionService from "../../../orchestration-v2/RunExecutionService.ts";
import * as RuntimePolicy from "../../../orchestration-v2/RuntimePolicy.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../../project/WorktreeSetupTracker.ts";
import * as ProviderAuthService from "../../../provider/Services/ProviderAuthService.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Fork: the session_* tools, end to end through the MCP server, on a real v2
// orchestrator with an in-memory database. Provider processes never start, so
// a launched session stays in its first run, which is what "running" means here.

const projectId = ProjectId.make("project:t3code");
const otherProjectId = ProjectId.make("project:fleet");
const projectRoot = NodePath.join(NodeOS.tmpdir(), "t3-session-tools-root");
const projects = [
  { id: projectId, title: "t3code", workspaceRoot: projectRoot },
  { id: otherProjectId, title: "fleet", workspaceRoot: "/work/fleet" },
].map((project) => ({
  ...project,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
}));

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const callerModel = { instanceId: claude, model: "claude-opus-5" };

const adapter = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(instanceId),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("provider processes never start in these tests"),
  }) as ProviderAdapterV2Shape;

const effortOption = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: ["low", "medium", "high"].map((id) => ({
    id,
    label: id,
    ...(id === "medium" ? { isDefault: true } : {}),
  })),
};

const provider = (
  instanceId: string,
  models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean }>,
  enabled = true,
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled,
    installed: true,
    status: "ready",
    models: models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      ...(model.isDefault ? { isDefault: true } : {}),
      capabilities: { optionDescriptors: [effortOption] },
    })),
  }) as unknown as ServerProvider;

const providers = [
  provider("claudeAgent", [
    { slug: "claude-opus-5", isDefault: true },
    { slug: "claude-sonnet-5" },
  ]),
  provider("codex", [{ slug: "gpt-5.5" }, { slug: "gpt-5.6", isDefault: true }]),
  provider("cursor", [{ slug: "auto" }], false),
];

/**
 * `worktrees` is what `git worktree list` reports for the project, as listRefs
 * carries it. `setupRuns` collects the directory of every setup-script run.
 * A launch titled with a name in `failLaunchOnce` creates its thread and then
 * fails, once, as a launch can after its thread exists.
 */
function makeHarness(
  worktrees: ReadonlyArray<{ readonly branch: string; readonly path: string }>,
  setupRuns: Array<string> = [],
  failLaunchOnce: Set<string> = new Set(),
) {
  const database = SqlitePersistenceMemory;
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "session-tools" },
    ProviderAdapterRegistry.makeLayer([adapter(claude), adapter(codex)]),
    { databaseLayer: database, runEffectWorker: false },
  );
  // Merged so a test can write provider events through the real event sink.
  const threadManagement = ThreadManagement.layer.pipe(Layer.provideMerge(orchestrator));
  const external = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === id))),
      snapshot: Effect.succeed({ projects, updatedAt: "2026-10-01T00:00:00.000Z" }),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      listRefs: () =>
        Effect.succeed({
          refs: worktrees.map((worktree) => ({
            name: worktree.branch,
            current: false,
            isDefault: false,
            worktreePath: worktree.path,
          })),
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: worktrees.length,
        }),
      createWorktree: () => Effect.die("spawn never creates a worktree"),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: (input) =>
        Effect.sync(() => {
          setupRuns.push(input.worktreePath);
          return { status: "no-script" as const };
        }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    ServerSettings.layerTest(),
    makeProviderRegistryLayer(providers),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const realLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        external,
        threadManagement,
        CommandReceiptStore.layer.pipe(Layer.provide(database)),
        IdAllocator.layer,
      ),
    ),
  );
  const launch = Layer.effect(
    ThreadLaunch.ThreadLaunchService,
    Effect.gen(function* () {
      const real = yield* ThreadLaunch.ThreadLaunchService;
      return ThreadLaunch.ThreadLaunchService.of({
        launch: (input) =>
          real.launch(input).pipe(
            Effect.flatMap((result) =>
              failLaunchOnce.delete(input.title)
                ? Effect.fail(
                    new ThreadLaunch.ThreadLaunchError({
                      operation: "dispatch-message",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      threadId: result.threadId,
                      cause: "failed by the test",
                    }),
                  )
                : Effect.succeed(result),
            ),
          ),
        retryPreparation: real.retryPreparation,
      });
    }),
  ).pipe(Layer.provide(realLaunch));
  return McpHttpServer.OrchestrationToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mergeAll(threadManagement, launch, external, NodeServices.layer, NodeCrypto.layer),
    ),
  );
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "session-tools-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "session-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const callTool = (
  caller: ThreadId,
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<"preview" | "orchestration"> = ["orchestration"],
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-session-tools"),
        threadId: caller,
        providerSessionId: "provider-session-session-tools",
        providerInstanceId: claude,
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

/** The text parts of a tool result, where an error's reason and detail land. */
const contentText = (result: { readonly content: ReadonlyArray<unknown> }) =>
  result.content.map((part) => (part as { readonly text?: string }).text ?? "").join("\n");

/** A tool call that must succeed, returning its structured result. */
const ok = (caller: ThreadId, name: string, args: Record<string, unknown> = {}) =>
  callTool(caller, name, args).pipe(
    Effect.map((result) => {
      expect(result.isError, contentText(result)).toBe(false);
      return result.structuredContent as Record<string, any>;
    }),
  );

/** A tool call that must fail, returning its error text. */
const refused = (caller: ThreadId, name: string, args: Record<string, unknown>) =>
  callTool(caller, name, args).pipe(
    Effect.map((result) => {
      expect(result.isError).toBe(true);
      return contentText(result);
    }),
  );

let commandCount = 0;
const dispatch = (command: (commandId: CommandId) => OrchestrationV2ServerCommand) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    commandCount += 1;
    yield* threads.dispatch(command(CommandId.make(`test:${commandCount}`)));
  });

/** A thread the user made, idle unless something sends it a message. */
const seed = (input: {
  readonly id: string;
  readonly title: string;
  readonly projectId?: ProjectId;
  readonly spawnedBy?: ThreadId;
  readonly group?: string;
  readonly worktree?: { readonly branch: string; readonly path: string };
  readonly pinKey?: string;
  readonly settled?: boolean;
}) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(input.id);
    yield* dispatch((commandId) => ({
      type: "thread.create",
      commandId,
      threadId,
      projectId: input.projectId ?? projectId,
      title: input.title,
      modelSelection: callerModel,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.worktree?.branch ?? null,
      worktreePath: input.worktree?.path ?? null,
      createdBy: "user",
      creationSource: "web",
    }));
    if (input.spawnedBy !== undefined || input.group !== undefined) {
      yield* dispatch((commandId) => ({
        type: "thread.metadata.update",
        commandId,
        threadId,
        ...(input.spawnedBy === undefined ? {} : { spawnedByThreadId: input.spawnedBy }),
        ...(input.group === undefined ? {} : { group: input.group }),
      }));
    }
    if (input.pinKey !== undefined) {
      yield* dispatch((commandId) => ({
        type: "thread.pin",
        commandId,
        threadId,
        orderKey: input.pinKey!,
      }));
    }
    if (input.settled === true) {
      yield* dispatch((commandId) => ({ type: "thread.settle", commandId, threadId }));
    }
    return threadId;
  });

const shellOf = (threadId: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    expect(shell).not.toBeNull();
    return shell!;
  });

const projectionOf = (threadId: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads.getThreadProjection(ThreadId.make(threadId));
  });

/**
 * Puts a steerable turn on an idle thread, as a provider mid-turn leaves it,
 * and optionally a question it is waiting on. Returns the run.
 */
const runningTurn = (threadId: ThreadId, options: { readonly question?: boolean } = {}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`run:${threadId}`);
    const attemptId = RunAttemptId.make(`attempt:${threadId}`);
    const nodeId = NodeId.make(`node:${threadId}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const providerTurnId = ProviderTurnId.make(`provider-turn:${threadId}`);
    const events: Array<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make(`${threadId}:provider-thread`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: ProviderDriverKind.make(claude),
          providerInstanceId: claude,
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
          providerInstanceId: claude,
          modelSelection: callerModel,
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
          providerInstanceId: claude,
          providerThreadId,
          providerTurnId,
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
          id: providerTurnId,
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
    ];
    if (options.question === true) {
      events.push({
        id: EventId.make(`${threadId}:question`),
        type: "runtime-request.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(`question:${threadId}`),
          nodeId: NodeId.make(`question-node:${threadId}`),
          providerTurnId,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make(`session:${threadId}`),
          },
          createdAt: now,
          resolvedAt: null,
        },
      });
    }
    yield* sink.write({ events });
    return runId;
  });

const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const orchestratorId = ThreadId.make("thread:orchestrator");
const seedOrchestrator = seed({ id: orchestratorId, title: "Orchestrator" });

it.effect("refuses every tool without the orchestration capability", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    const result = yield* callTool(orchestratorId, "session_list", {}, ["preview"]);
    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain("capability-unavailable");
  }).pipe(Effect.provide(makeHarness([]))),
);

it.effect(
  "spawns a watched, grouped session sent by the caller, leaving the caller ungrouped",
  () =>
    Effect.gen(function* () {
      yield* seedOrchestrator;
      const spawned = yield* ok(orchestratorId, "session_spawn", {
        name: "L2-dev",
        group: "L2",
        message: "Build the lane.",
      });
      expect(spawned).toMatchObject({
        name: "L2-dev",
        group: "L2",
        projectId,
        instanceId: "claudeAgent",
        model: "claude-opus-5",
        adopted: [],
        branch: null,
        worktreePath: null,
      });

      const thread = yield* shellOf(spawned.threadId);
      expect(thread).toMatchObject({
        title: "L2-dev",
        group: "L2",
        spawnedByThreadId: orchestratorId,
        runtimeMode: "full-access",
        createdBy: "agent",
        creationSource: "mcp",
        lineage: { relationshipToParent: null },
      });
      expect(thread.pinnedAt == null).toBe(true);
      const projection = yield* projectionOf(spawned.threadId);
      expect(projection.messages[0]).toMatchObject({
        text: "Build the lane.",
        senderThreadId: orchestratorId,
        createdBy: "agent",
      });
      expect((yield* shellOf(orchestratorId)).group == null).toBe(true);
    }).pipe(Effect.provide(makeHarness([]))),
);

it.effect("refuses a name an open or settled session holds, an empty message, and a bad name", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    yield* seed({ id: "thread:open", title: "L2-dev" });
    yield* seed({ id: "thread:settled", title: "L2-review", settled: true });
    const before = (yield* ok(orchestratorId, "session_list", { project: "*" })).sessions.length;

    const open = yield* refused(orchestratorId, "session_spawn", {
      name: "L2-dev",
      group: "L2",
      message: "Again.",
    });
    expect(open).toContain("already-exists");
    expect(open).toContain("use session_wake");
    const settled = yield* refused(orchestratorId, "session_spawn", {
      name: "L2-review",
      group: "L2",
      message: "Again.",
    });
    expect(settled).toContain("a settled session named L2-review still holds that name");
    expect(
      yield* refused(orchestratorId, "session_spawn", { name: "L2-x", group: "L2", message: " " }),
    ).toContain("message must not be empty");
    // The MCP server rejects a malformed name before the tool runs.
    const badName = yield* callTool(orchestratorId, "session_spawn", {
      name: "has spaces",
      group: "L2",
      message: "Go.",
    }).pipe(Effect.flip);
    expect(badName._tag).toBe("InvalidParams");

    // The same name is free in another project, checked against that project.
    const elsewhere = yield* ok(orchestratorId, "session_spawn", {
      name: "L2-dev",
      group: "L2",
      message: "Go.",
      project: "fleet",
    });
    expect(elsewhere.projectId).toBe(otherProjectId);
    expect((yield* ok(orchestratorId, "session_list", { project: "*" })).sessions.length).toBe(
      before + 1,
    );
  }).pipe(Effect.provide(makeHarness([]))),
);

/**
 * Launch preparation runs on a background fiber with no receipt to wait on, so
 * this yields to it until the condition holds, as ThreadLaunchService's tests do.
 */
const waitUntil = <E, R>(predicate: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* predicate) return;
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    expect.fail("condition was not reached");
  });

const prepared = (threadId: string) =>
  waitUntil(
    projectionOf(threadId).pipe(
      Effect.map((projection) => !projection.runs.some((run) => run.status === "preparing")),
    ),
  );

it.effect(
  "never runs the project's setup script for a spawn, while upstream's launch still does",
  () =>
    Effect.gen(function* () {
      const lane = yield* tempDir("t3-setup-lane-");
      const setupRuns: Array<string> = [];
      yield* Effect.gen(function* () {
        yield* seedOrchestrator;
        for (const spawn of [
          { name: "S-main" },
          { name: "S-dev", worktree: { path: lane, branch: "lane/S" } },
          { name: "S-review", worktree: { sameAs: "S-dev" } },
        ]) {
          const spawned = yield* ok(orchestratorId, "session_spawn", {
            group: "S",
            message: "Go.",
            ...spawn,
          });
          yield* prepared(spawned.threadId);
        }
        expect(setupRuns).toEqual([]);

        // The same project launched the way the composer launches it runs setup.
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        yield* launches.launch({
          commandId: CommandId.make("test:user-launch"),
          threadId: ThreadId.make("thread:user-launch"),
          projectId,
          title: "User thread",
          modelSelection: callerModel,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Go.", attachments: [] },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(Effect.sync(() => setupRuns.length > 0));
        expect(setupRuns).toEqual([projectRoot]);
      }).pipe(Effect.provide(makeHarness([{ branch: "lane/S", path: lane }], setupRuns)));
    }).pipe(Effect.scoped),
);

it.effect("attaches a worktree git lists with that branch, and refuses anything else", () =>
  Effect.gen(function* () {
    const lane = yield* tempDir("t3-lane-");
    const unlisted = yield* tempDir("t3-unlisted-");
    yield* Effect.gen(function* () {
      yield* seedOrchestrator;
      const spawn = (name: string, worktree: Record<string, string>) =>
        callTool(orchestratorId, "session_spawn", {
          name,
          group: "L9",
          message: "Work the lane.",
          worktree,
        });

      const notListed = yield* spawn("L9-a", { path: unlisted, branch: "lane/L9" });
      expect(contentText(notListed)).toContain("invalid-worktree");
      expect(contentText(notListed)).toContain("does not list");
      const wrongBranch = yield* spawn("L9-b", { path: lane, branch: "lane/L8" });
      expect(contentText(wrongBranch)).toContain("has lane/L9 checked out, not lane/L8");
      expect((yield* ok(orchestratorId, "session_list", {})).sessions).toHaveLength(1);

      const attached = yield* ok(orchestratorId, "session_spawn", {
        name: "L9-dev",
        group: "L9",
        message: "Work the lane.",
        worktree: { path: lane, branch: "lane/L9" },
      });
      expect(attached).toMatchObject({ branch: "lane/L9", worktreePath: lane });
      expect(yield* shellOf(attached.threadId)).toMatchObject({
        branch: "lane/L9",
        worktreePath: lane,
      });

      // sameAs copies another session's worktree.
      const reviewer = yield* ok(orchestratorId, "session_spawn", {
        name: "L9-review",
        group: "L9",
        message: "Review the lane.",
        worktree: { sameAs: "L9-dev" },
      });
      expect(reviewer).toMatchObject({ branch: "lane/L9", worktreePath: lane });
    }).pipe(Effect.provide(makeHarness([{ branch: "lane/L9", path: lane }])));
  }).pipe(Effect.scoped),
);

it.effect("runs a spawn on another provider or model, and refuses an option the model lacks", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    const onCodex = yield* ok(orchestratorId, "session_spawn", {
      name: "on-codex",
      group: "models",
      message: "Go.",
      instanceId: "codex",
    });
    expect(onCodex).toMatchObject({ instanceId: "codex", model: "gpt-5.6", options: [] });
    expect((yield* shellOf(onCodex.threadId)).modelSelection).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.6",
    });

    const highEffort = yield* ok(orchestratorId, "session_spawn", {
      name: "on-sonnet",
      group: "models",
      message: "Go.",
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(highEffort).toMatchObject({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "high" }],
    });

    const badEffort = yield* refused(orchestratorId, "session_spawn", {
      name: "bad-effort",
      group: "models",
      message: "Go.",
      options: [{ id: "effort", value: "ultra" }],
    });
    expect(badEffort).toContain("invalid-model");
    expect(
      yield* refused(orchestratorId, "session_spawn", {
        name: "on-cursor",
        group: "models",
        message: "Go.",
        instanceId: "cursor",
      }),
    ).toContain("no usable provider cursor");
  }).pipe(Effect.provide(makeHarness([]))),
);

it.effect(
  "hands off: the successor is a pinned sibling that adopts the roster and the worktree",
  () =>
    Effect.gen(function* () {
      const lane = { branch: "lane/L5", path: yield* tempDir("t3-handoff-lane-") };
      yield* Effect.gen(function* () {
        const root = yield* seed({ id: "thread:root", title: "Root" });
        const caller = yield* seed({
          id: "thread:lead",
          title: "Lead",
          spawnedBy: root,
          worktree: lane,
          pinKey: "a5",
        });
        yield* seed({ id: "thread:worker-1", title: "L5-dev", spawnedBy: caller, group: "L5" });
        yield* seed({ id: "thread:worker-2", title: "L5-review", spawnedBy: caller, group: "L5" });
        yield* seed({ id: "thread:unrelated", title: "Other", spawnedBy: root });

        const successor = yield* ok(caller, "session_spawn", {
          name: "Lead-2",
          group: "leads",
          message: "Take over.",
          handoff: true,
        });
        expect(successor).toMatchObject({
          adopted: ["L5-dev", "L5-review"],
          branch: lane.branch,
          worktreePath: lane.path,
        });
        const next = yield* shellOf(successor.threadId);
        expect(next).toMatchObject({
          spawnedByThreadId: root,
          pinOrderKey: "a5",
          worktreePath: lane.path,
        });
        expect(next.pinnedAt != null).toBe(true);
        expect((yield* shellOf("thread:worker-1")).spawnedByThreadId).toBe(successor.threadId);
        expect((yield* shellOf("thread:worker-2")).spawnedByThreadId).toBe(successor.threadId);
        expect((yield* shellOf("thread:unrelated")).spawnedByThreadId).toBe(root);
        expect((yield* shellOf(caller)).successorThreadId).toBe(successor.threadId);

        // A plain spawn is never pinned and runs on the main checkout.
        const plain = yield* ok(caller, "session_spawn", {
          name: "L5-tests",
          group: "L5",
          message: "Go.",
        });
        expect(plain).toMatchObject({ branch: null, worktreePath: null });
        expect((yield* shellOf(plain.threadId)).pinnedAt == null).toBe(true);
      }).pipe(Effect.provide(makeHarness([lane])));
    }).pipe(Effect.scoped),
);

it.effect("lists open sessions in one project, a named one, or all, with status and self", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    const lane = { branch: "lane/L1", path: NodePath.join(projectRoot, "lanes", "L1") };
    yield* seed({ id: "thread:idle", title: "L1-dev", group: "L1", worktree: lane });
    yield* seed({ id: "thread:done", title: "L1-old", group: "L1", settled: true });
    yield* seed({ id: "thread:fleet", title: "fleet-dev", projectId: otherProjectId });
    yield* seed({ id: "thread:archived", title: "L1-gone", group: "L1" });
    yield* dispatch((commandId) => ({
      type: "thread.archive",
      commandId,
      threadId: ThreadId.make("thread:archived"),
    }));
    const busy = yield* ok(orchestratorId, "session_spawn", {
      name: "L1-review",
      group: "L1",
      message: "Review.",
    });

    const own = yield* ok(orchestratorId, "session_list", {});
    const rows = Object.fromEntries(
      own.sessions.map((row: Record<string, unknown>) => [row.name, row]),
    );
    expect(Object.keys(rows).toSorted()).toEqual(["L1-dev", "L1-review", "Orchestrator"]);
    expect(rows["Orchestrator"]).toMatchObject({ self: true, group: null, project: "t3code" });
    expect(rows["L1-dev"]).toMatchObject({
      self: false,
      group: "L1",
      status: "ready",
      branch: lane.branch,
      worktreePath: lane.path,
    });
    expect(rows["L1-review"]).toMatchObject({ threadId: busy.threadId, status: "running" });

    const grouped = yield* ok(orchestratorId, "session_list", { group: "L1" });
    expect(grouped.sessions.map((row: Record<string, unknown>) => row.name).toSorted()).toEqual([
      "L1-dev",
      "L1-review",
    ]);
    const fleet = yield* ok(orchestratorId, "session_list", { project: "fleet" });
    expect(fleet.sessions).toMatchObject([{ name: "fleet-dev", project: "fleet" }]);
    const all = yield* ok(orchestratorId, "session_list", { project: "*" });
    expect(all.sessions).toHaveLength(4);
    expect(yield* refused(orchestratorId, "session_list", { project: "nowhere" })).toContain(
      "project-not-found",
    );

    // A settled caller still finds its own row.
    yield* dispatch((commandId) => ({
      type: "thread.settle",
      commandId,
      threadId: orchestratorId,
    }));
    const settledSelf = yield* ok(orchestratorId, "session_list", {});
    expect(
      settledSelf.sessions.find((row: Record<string, unknown>) => row.self === true),
    ).toBeDefined();
  }).pipe(Effect.provide(makeHarness([]))),
);

it.effect("lists models and projects, marking the caller's", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    const models = yield* ok(orchestratorId, "session_models", {});
    expect(models.providers.map((row: Record<string, unknown>) => row.instanceId)).toEqual([
      "claudeAgent",
      "codex",
    ]);
    expect(models.providers[0]).toMatchObject({
      current: true,
      models: [
        {
          slug: "claude-opus-5",
          isDefault: true,
          options: [{ id: "effort", choices: ["low", "medium", "high"], default: "medium" }],
        },
        { slug: "claude-sonnet-5", isDefault: false },
      ],
    });
    const codexOnly = yield* ok(orchestratorId, "session_models", { instanceId: "codex" });
    expect(codexOnly.providers).toMatchObject([{ instanceId: "codex", current: false }]);

    const listed = yield* ok(orchestratorId, "session_projects", {});
    expect(listed.projects).toEqual([
      { projectId, name: "t3code", path: projectRoot, current: true },
      { projectId: otherProjectId, name: "fleet", path: "/work/fleet", current: false },
    ]);
    const matched = yield* ok(orchestratorId, "session_projects", { match: "FLE" });
    expect(matched.projects).toMatchObject([{ name: "fleet" }]);
  }).pipe(Effect.provide(makeHarness([]))),
);

it.effect(
  "wakes by name or threadId: starts, reopens a settled session elsewhere, queues on a busy one",
  () =>
    Effect.gen(function* () {
      yield* seedOrchestrator;
      yield* seed({ id: "thread:idle", title: "L3-dev" });
      const remote = yield* seed({
        id: "thread:fleet-settled",
        title: "fleet-lead",
        projectId: otherProjectId,
        settled: true,
      });
      expect((yield* shellOf(remote)).settledOverride).toBe("settled");

      const started = yield* ok(orchestratorId, "session_wake", { name: "L3-dev", message: "Go." });
      expect(started).toEqual({ threadId: "thread:idle", name: "L3-dev", delivery: "started" });

      // A name never reaches another project; its threadId does, and the
      // message reopens the settled session there.
      expect(
        yield* refused(orchestratorId, "session_wake", { name: "fleet-lead", message: "Hi." }),
      ).toContain("thread-not-found");
      const reopened = yield* ok(orchestratorId, "session_wake", {
        name: remote,
        message: "Pause.",
      });
      expect(reopened).toMatchObject({ threadId: remote, name: "fleet-lead" });
      expect((yield* shellOf(remote)).settledOverride).toBeNull();
      const projection: OrchestrationV2ThreadProjection = yield* projectionOf(remote);
      expect(projection.messages.at(-1)).toMatchObject({
        text: "Pause.",
        senderThreadId: orchestratorId,
        createdBy: "agent",
        creationSource: "mcp",
      });

      // A session whose turn is in flight still gets the message, behind it.
      const busy = yield* ok(orchestratorId, "session_spawn", {
        name: "L3-review",
        group: "L3",
        message: "Review.",
      });
      const queued = yield* ok(orchestratorId, "session_wake", {
        name: busy.threadId,
        message: "Also check the tests.",
      });
      expect(queued.delivery).toBe("queued");
    }).pipe(Effect.provide(makeHarness([]))),
);

// A steer aborts the open question and the provider asks it again, leaving the
// old card unanswerable (pingdotgg/t3code#15517).
it.effect("wakes a session with a question open into its queue instead of steering", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    const working = yield* seed({ id: "thread:working", title: "L5-dev" });
    const asking = yield* seed({ id: "thread:asking", title: "L5-review" });
    const workingRun = yield* runningTurn(working);
    const askingRun = yield* runningTurn(asking, { question: true });
    expect((yield* shellOf(asking)).pendingRuntimeRequest).toMatchObject({ kind: "user_input" });

    // Both turns are alike, and a queue behind one succeeds (below). Without a
    // question the wake steers instead, which needs the turn's live provider
    // session, and no provider process runs here, so the steer is refused.
    const steered = yield* refused(orchestratorId, "session_wake", {
      name: working,
      message: "Also check the tests.",
    });
    expect(steered).toContain("dispatch-failed");
    expect((yield* projectionOf(working)).runs.map((run) => run.id)).toEqual([workingRun]);

    const queued = yield* ok(orchestratorId, "session_wake", {
      name: asking,
      message: "Also check the tests.",
    });
    expect(queued.delivery).toBe("queued");
    const projection = yield* projectionOf(asking);
    expect(projection.runs.map((run) => [run.id === askingRun, run.status])).toEqual([
      [true, "running"],
      [false, "queued"],
    ]);
    expect(projection.runtimeRequests.map((request) => request.status)).toEqual(["pending"]);
  }).pipe(Effect.provide(makeHarness([]))),
);

it.effect(
  "settles with the roster it spawned, leaving busy children open and refusing busy targets",
  () =>
    Effect.gen(function* () {
      yield* seedOrchestrator;
      const lead = yield* seed({ id: "thread:lead", title: "Lead", spawnedBy: orchestratorId });
      yield* seed({ id: "thread:child-idle", title: "L4-dev", spawnedBy: lead });
      yield* seed({ id: "thread:child-done", title: "L4-old", spawnedBy: lead, settled: true });
      yield* seed({
        id: "thread:grandchild",
        title: "L4-sub",
        spawnedBy: ThreadId.make("thread:child-idle"),
      });
      const busyChild = yield* ok(lead, "session_spawn", {
        name: "L4-review",
        group: "L4",
        message: "Go.",
      });

      expect(yield* refused(orchestratorId, "session_settle", { name: "Orchestrator" })).toContain(
        "cannot settle itself",
      );
      const blocked = yield* refused(orchestratorId, "session_settle", {
        name: busyChild.threadId,
      });
      expect(blocked).toContain("settle-blocked");
      expect((yield* shellOf(busyChild.threadId)).settledOverride).toBeNull();

      const settled = yield* ok(orchestratorId, "session_settle", { name: lead });
      expect(settled).toEqual({
        threadId: lead,
        name: "Lead",
        settledWith: ["L4-dev"],
        leftOpen: ["L4-review"],
      });
      expect((yield* shellOf(lead)).settledOverride).toBe("settled");
      expect((yield* shellOf("thread:child-idle")).settledOverride).toBe("settled");
      expect((yield* shellOf("thread:grandchild")).settledOverride).toBeNull();
      expect((yield* shellOf(busyChild.threadId)).settledOverride).toBeNull();

      // Settling again is harmless.
      expect(yield* ok(orchestratorId, "session_settle", { name: lead })).toMatchObject({
        settledWith: [],
        leftOpen: ["L4-review"],
      });
    }).pipe(Effect.provide(makeHarness([]))),
);

it.effect("renames by name, by threadId across projects, and itself, keeping names unique", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    yield* seed({ id: "thread:dev", title: "L6-dev" });
    yield* seed({ id: "thread:old", title: "Orchestrator-old", settled: true });
    const remote = yield* seed({
      id: "thread:remote",
      title: "fleet-dev",
      projectId: otherProjectId,
    });

    expect(
      yield* ok(orchestratorId, "session_rename", { session: "L6-dev", name: "L6-dev-2" }),
    ).toEqual({ threadId: "thread:dev", name: "L6-dev-2", previousName: "L6-dev" });
    expect(
      yield* ok(orchestratorId, "session_rename", { session: remote, name: "fleet-dev-2" }),
    ).toMatchObject({ previousName: "fleet-dev" });
    expect((yield* shellOf(remote)).title).toBe("fleet-dev-2");

    const clash = yield* refused(orchestratorId, "session_rename", {
      session: "Orchestrator",
      name: "Orchestrator-old",
    });
    expect(clash).toContain("a settled session named Orchestrator-old still holds that name");
    expect(
      yield* ok(orchestratorId, "session_rename", { session: "Orchestrator", name: "Lead" }),
    ).toMatchObject({ name: "Lead", previousName: "Orchestrator" });
    expect((yield* shellOf(orchestratorId)).title).toBe("Lead");
  }).pipe(Effect.provide(makeHarness([]))),
);

/**
 * Runs one provider turn start on `thread` with its worktree directory
 * missing, T3's own worktrees living under `worktreesDir`. Reports whether T3
 * recreated the worktree, and the error item it wrote if it failed the run
 * instead. A start that gets past the worktree check stops at a stub.
 */
const turnStartWithMissingWorktree = (
  thread: OrchestrationV2ThreadProjection["thread"],
  worktreesDir: string,
) =>
  Effect.gen(function* () {
    let recreated = false;
    const written: Array<OrchestrationV2DomainEvent> = [];
    const layer = Layer.fresh(ProviderTurnStart.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Effect.sync(() => {
                written.push(...input.events);
                return { committed: true, storedEvents: [] } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.succeed(FileSystem.FileSystem, {
            exists: () => Effect.succeed(false),
            realPath: (target: string) => Effect.succeed(target),
          } as never),
          Layer.succeed(ServerConfig.ServerConfig, { worktreesDir } as never),
          NodePathLayer.layer,
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: () => Effect.void,
            createWorktree: () =>
              Effect.sync(() => {
                recreated = true;
                return {} as never;
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(projects[0] as never)),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getTurnStartContext: () =>
              Effect.succeed({
                thread,
                runs: [
                  {
                    id: "run:guard",
                    status: "starting",
                    providerInstanceId: claude,
                    rootNodeId: "node:guard",
                    activeAttemptId: "attempt:guard",
                    providerThreadId: "provider-thread:guard",
                    userMessageId: "message:guard",
                    ordinal: 2,
                  },
                ],
                nodes: [{ id: "node:guard", checkpointScopeId: "scope:guard" }],
                attempts: [{ id: "attempt:guard" }],
                providerThreads: [
                  {
                    id: "provider-thread:guard",
                    providerSessionId: "provider-session:guard",
                    nativeThreadRef: null,
                  },
                ],
                messages: [{ id: "message:guard", role: "user", text: "Go.", attachments: [] }],
                checkpointScopes: [{ id: "scope:guard" }],
                contextHandoffs: [],
                contextTransfers: [],
                turnItems: [],
                hasConversation: true,
              } as never),
            // Stops a start that got past the worktree check.
            getRuntimeRecoveryProjection: (threadId) =>
              Effect.fail(
                new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "stop" }),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ProviderAuthService.ProviderAuthService)({
            tryHandlePromptCommand: () => Effect.succeed(false),
          }),
          Layer.mock(RunExecutionService.RunExecutionServiceV2)({}),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
        ),
      ),
    );
    const exit = yield* Effect.gen(function* () {
      const turnStart = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      return yield* turnStart.start({ threadId: thread.id, runId: "run:guard" as never });
    }).pipe(Effect.provide(layer), Effect.exit);
    const errorItem = written.flatMap((event) =>
      event.type === "turn-item.updated" && event.payload.type === "error" ? [event.payload] : [],
    )[0];
    const failedRun = written.some(
      (event) => event.type === "run.updated" && event.payload.status === "failed",
    );
    // A start that carried on past the check hit the stub and failed there.
    return { recreated, errorItem, failedRun, carriedOn: Exit.isFailure(exit) };
  });

it.effect(
  "recreates only worktrees inside T3's own dir, and fails a turn in a missing attached one",
  () =>
    Effect.gen(function* () {
      const worktreesDir = yield* tempDir("t3-own-worktrees-");
      const attachedLane = yield* tempDir("t3-guard-lane-");
      const ownLane = NodePath.join(worktreesDir, "t3code", "L7-review");
      NodeFS.mkdirSync(ownLane, { recursive: true });
      const { attached, own, userMade } = yield* Effect.gen(function* () {
        const caller = yield* seed({
          id: "thread:guard-lead",
          title: "Lead",
          worktree: { branch: "lane/L7", path: attachedLane },
        });
        const attached = yield* ok(caller, "session_spawn", {
          name: "L7-dev",
          group: "L7",
          message: "Go.",
          worktree: { path: attachedLane, branch: "lane/L7" },
        });
        const own = yield* ok(caller, "session_spawn", {
          name: "L7-review",
          group: "L7",
          message: "Go.",
          worktree: { path: ownLane, branch: "lane/L7-review" },
        });
        return {
          attached: (yield* projectionOf(attached.threadId)).thread,
          own: (yield* projectionOf(own.threadId)).thread,
          userMade: (yield* projectionOf(caller)).thread,
        };
      }).pipe(
        Effect.provide(
          makeHarness([
            { branch: "lane/L7", path: attachedLane },
            { branch: "lane/L7-review", path: ownLane },
          ]),
        ),
      );

      // Outside T3's dir: not recreated, and the turn fails saying why, whether
      // or not the thread has a spawner.
      for (const thread of [attached, userMade]) {
        const outcome = yield* turnStartWithMissingWorktree(thread, worktreesDir);
        expect(outcome).toMatchObject({ recreated: false, failedRun: true, carriedOn: false });
        expect(outcome.errorItem?.failure.message).toContain(
          `Attached worktree ${attachedLane} no longer exists`,
        );
      }
      // Inside T3's dir: upstream's repair, even for a spawned session.
      const repaired = yield* turnStartWithMissingWorktree(own, worktreesDir);
      expect(repaired).toMatchObject({ recreated: true, failedRun: false, carriedOn: true });
    }).pipe(Effect.scoped),
);

it.effect("refuses sameAs or a handoff onto a worktree that is gone", () =>
  Effect.gen(function* () {
    const lane = yield* tempDir("t3-gone-lane-");
    const gone = NodePath.join(lane, "removed");
    yield* Effect.gen(function* () {
      yield* seedOrchestrator;
      const dev = yield* seed({
        id: "thread:gone",
        title: "L8-dev",
        worktree: { branch: "lane/L8", path: gone },
      });
      const sameAs = yield* refused(orchestratorId, "session_spawn", {
        name: "L8-review",
        group: "L8",
        message: "Go.",
        worktree: { sameAs: "L8-dev" },
      });
      expect(sameAs).toContain("invalid-worktree");
      expect(sameAs).toContain(`${gone} does not exist`);
      const handoff = yield* refused(dev, "session_spawn", {
        name: "L8-dev-2",
        group: "L8",
        message: "Take over.",
        handoff: true,
      });
      expect(handoff).toContain(`${gone} does not exist`);
      expect((yield* ok(orchestratorId, "session_list", {})).sessions).toHaveLength(2);
    }).pipe(Effect.provide(makeHarness([{ branch: "lane/L8", path: gone }])));
  }).pipe(Effect.scoped),
);

it.effect("cascades every explicit settle to the spawned sessions, but not an automatic one", () =>
  Effect.gen(function* () {
    const lead = yield* seed({ id: "thread:lead", title: "Lead" });
    yield* seed({ id: "thread:idle", title: "L9-dev", spawnedBy: lead });
    yield* seed({ id: "thread:sub", title: "L9-sub", spawnedBy: ThreadId.make("thread:idle") });
    const busy = yield* ok(lead, "session_spawn", {
      name: "L9-review",
      group: "L9",
      message: "Go.",
    });

    // A plain thread.settle, as the sidebar sends it.
    yield* dispatch((commandId) => ({ type: "thread.settle", commandId, threadId: lead }));
    expect((yield* shellOf(lead)).settledOverride).toBe("settled");
    expect((yield* shellOf("thread:idle")).settledOverride).toBe("settled");
    expect((yield* shellOf("thread:sub")).settledOverride).toBeNull();
    expect((yield* shellOf(busy.threadId)).settledOverride).toBeNull();

    // Automatic settlement settles the thread alone.
    const quiet = yield* seed({ id: "thread:quiet", title: "Quiet" });
    yield* seed({ id: "thread:quiet-child", title: "Quiet-dev", spawnedBy: quiet });
    const snapshotAt = yield* DateTime.now;
    yield* dispatch((commandId) => ({
      type: "thread.auto-settle",
      commandId,
      threadId: quiet,
      snapshotAt,
    }));
    expect((yield* shellOf(quiet)).settledOverride).toBe("settled");
    expect((yield* shellOf("thread:quiet-child")).settledOverride).toBeNull();
  }).pipe(Effect.provide(makeHarness([]))),
);

it.effect("archives a session whose spawn failed after its thread existed, freeing the name", () =>
  Effect.gen(function* () {
    yield* seedOrchestrator;
    const failed = yield* refused(orchestratorId, "session_spawn", {
      name: "L10-dev",
      group: "L10",
      message: "Go.",
    });
    expect(failed).toContain("dispatch-failed");
    expect(failed).toContain("was archived, so the name L10-dev is free");
    const orphanId = /the new session (\S+) was archived/.exec(failed)?.[1];
    expect(orphanId).toBeDefined();
    expect((yield* shellOf(orphanId!)).archivedAt).not.toBeNull();
    expect((yield* ok(orchestratorId, "session_list", {})).sessions).toHaveLength(1);

    const retried = yield* ok(orchestratorId, "session_spawn", {
      name: "L10-dev",
      group: "L10",
      message: "Go.",
    });
    expect(retried.threadId).not.toBe(orphanId);
  }).pipe(Effect.provide(makeHarness([], [], new Set(["L10-dev"])))),
);

it.effect(
  "spawns a standalone session with no spawner, out of reach of the caller's settle and handoff",
  () =>
    Effect.gen(function* () {
      const root = yield* seed({ id: "thread:root", title: "Root" });
      const lead = yield* seed({ id: "thread:lead", title: "Lead", spawnedBy: root });
      const standalone = yield* ok(lead, "session_spawn", {
        name: "Fleet-orch",
        group: "orchestrator",
        project: "fleet",
        message: "Run this project.",
        standalone: true,
      });
      expect(standalone).toMatchObject({ projectId: otherProjectId, adopted: [] });
      expect(yield* shellOf(standalone.threadId)).toMatchObject({
        spawnedByThreadId: null,
        group: "orchestrator",
        projectId: otherProjectId,
      });
      yield* ok(lead, "session_spawn", { name: "L7-dev", group: "L7", message: "Go." });

      expect(
        yield* refused(lead, "session_spawn", {
          name: "Lead-x",
          group: "leads",
          message: "Take over.",
          standalone: true,
          handoff: true,
        }),
      ).toContain("invalid-arguments");

      // Both spawned sessions are mid-turn, so a child would show as left open.
      expect(yield* ok(root, "session_settle", { name: lead })).toMatchObject({
        settledWith: [],
        leftOpen: ["L7-dev"],
      });
      expect((yield* shellOf(standalone.threadId)).settledOverride).toBeNull();

      const successor = yield* ok(lead, "session_spawn", {
        name: "Lead-2",
        group: "leads",
        message: "Take over.",
        handoff: true,
      });
      expect(successor.adopted).toEqual(["L7-dev"]);
      expect((yield* shellOf(successor.threadId)).spawnedByThreadId).toBe(root);
      expect((yield* shellOf(standalone.threadId)).spawnedByThreadId).toBeNull();
    }).pipe(Effect.provide(makeHarness([]))),
);

it.effect(
  "releases only sessions the caller spawned, open or settled, so its settle no longer cascades",
  () =>
    Effect.gen(function* () {
      const lead = yield* seed({ id: "thread:lead", title: "Lead" });
      const other = yield* seed({ id: "thread:other", title: "Other" });
      yield* seed({ id: "thread:idle", title: "L8-dev", spawnedBy: lead, group: "L8" });
      yield* seed({
        id: "thread:done",
        title: "L8-old",
        projectId: otherProjectId,
        spawnedBy: lead,
        settled: true,
      });
      yield* seed({ id: "thread:foreign", title: "Foreign", spawnedBy: other });
      yield* seed({ id: "thread:loner", title: "Loner" });

      const foreign = yield* refused(lead, "session_release", { name: "Foreign" });
      expect(foreign).toContain("not-spawner");
      expect(foreign).toContain("spawned by Other (thread:other)");
      expect(yield* refused(lead, "session_release", { name: "Loner" })).toContain(
        "has no spawner",
      );
      expect((yield* shellOf("thread:foreign")).spawnedByThreadId).toBe(other);

      expect(yield* ok(lead, "session_release", { name: "L8-dev" })).toEqual({
        threadId: "thread:idle",
        name: "L8-dev",
      });
      expect(yield* shellOf("thread:idle")).toMatchObject({
        spawnedByThreadId: null,
        group: "L8",
        settledOverride: null,
      });
      // By threadId in another project, on a settled session, which stays settled.
      expect(yield* ok(lead, "session_release", { name: "thread:done" })).toMatchObject({
        name: "L8-old",
      });
      expect(yield* shellOf("thread:done")).toMatchObject({
        spawnedByThreadId: null,
        settledOverride: "settled",
      });
      expect(yield* refused(lead, "session_release", { name: "L8-dev" })).toContain(
        "has no spawner",
      );

      // A plain thread.settle, as the sidebar sends it, no longer reaches it.
      yield* dispatch((commandId) => ({ type: "thread.settle", commandId, threadId: lead }));
      expect((yield* shellOf(lead)).settledOverride).toBe("settled");
      expect((yield* shellOf("thread:idle")).settledOverride).toBeNull();
    }).pipe(Effect.provide(makeHarness([]))),
);
