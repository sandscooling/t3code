import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { OrchestrationThreadSettleBlockedError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-orchestration-test");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const callerId = ThreadId.make("thread-orchestrator");

const invocation = (capabilities: ReadonlyArray<"preview" | "orchestration">) => ({
  environmentId,
  threadId: callerId,
  providerSessionId: "provider-session-orchestration-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "orchestration-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestration-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

function shell(input: {
  readonly id: string;
  readonly title: string;
  readonly projectId?: ProjectId;
  readonly group?: string | null;
  readonly parentThreadId?: string | null;
  readonly archivedAt?: string | null;
  readonly status?: "running" | "ready" | "stopped";
  readonly settled?: boolean;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId: input.projectId ?? projectId,
    title: input.title,
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    group: input.group ?? null,
    parentThreadId: input.parentThreadId == null ? null : ThreadId.make(input.parentThreadId),
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    settledOverride: input.settled === true ? "settled" : null,
    settledAt: input.settled === true ? "2026-01-03T00:00:00.000Z" : null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    session:
      input.status === undefined
        ? null
        : ({ threadId: ThreadId.make(input.id), status: input.status } as never),
  } as unknown as OrchestrationThreadShell;
}

const effortOption = (choices: ReadonlyArray<string>, fallback: string) => ({
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: choices.map((id) => ({
    id,
    label: id,
    ...(id === fallback ? { isDefault: true } : {}),
  })),
});

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled?: boolean;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean }>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    status: "ready",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      ...(model.isDefault ? { isDefault: true } : {}),
      capabilities: { optionDescriptors: [effortOption(["low", "medium", "high"], "medium")] },
    })),
  } as unknown as ServerProvider;
}

const baseProviders = [
  provider({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    models: [{ slug: "claude-opus-5", isDefault: true }, { slug: "claude-sonnet-5" }],
  }),
  provider({
    instanceId: "codex",
    driver: "codex",
    models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.6", isDefault: true }],
  }),
  provider({ instanceId: "cursor", driver: "cursor", enabled: false, models: [{ slug: "auto" }] }),
];

class RefusedByTest extends Data.TaggedError("RefusedByTest")<{ readonly message: string }> {}

/**
 * Stub engine that records what was dispatched and can be told to fail a
 * given command type once.
 */
function makeHarness(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  providers: ReadonlyArray<ServerProvider> = baseProviders,
) {
  const dispatched: Array<OrchestrationCommand> = [];
  const failing = new Set<OrchestrationCommand["type"]>();
  // Command types the decider would refuse as "still needs attention", which
  // the tools report differently from a generic dispatch failure.
  const blocking = new Set<OrchestrationCommand["type"]>();
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(
        (): Effect.Effect<
          { sequence: number },
          RefusedByTest | OrchestrationThreadSettleBlockedError
        > => {
          dispatched.push(command);
          if (failing.has(command.type)) {
            failing.delete(command.type);
            return Effect.fail(
              new RefusedByTest({ message: `dispatch of ${command.type} refused by test` }),
            );
          }
          if (blocking.has(command.type)) {
            blocking.delete(command.type);
            return Effect.fail(
              new OrchestrationThreadSettleBlockedError({
                threadId: (command as { threadId: ThreadId }).threadId,
              }),
            );
          }
          return Effect.succeed({ sequence: dispatched.length });
        },
      ),
  } as unknown as OrchestrationEngineShape;
  const query = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [
          { id: projectId, title: "t3code", workspaceRoot: "C:/source/t3code" },
          { id: otherProjectId, title: "fleet", workspaceRoot: "C:/source/fleet" },
        ],
        threads,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
  } as unknown as ProjectionSnapshotQueryShape;

  const layer = McpHttpServer.OrchestrationToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provideMerge(makeProviderRegistryLayer(providers)),
    Layer.provideMerge(NodeServices.layer),
  );
  return { dispatched, failing, blocking, layer };
}

const callTool = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<"preview" | "orchestration"> = ["orchestration"],
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const errorText = (result: { readonly content: unknown }) => JSON.stringify(result.content);

const baseThreads = [
  shell({ id: "thread-orchestrator", title: "orchestrator", status: "running" }),
  shell({ id: "thread-dev", title: "T-1234-dev", group: "T-1234", status: "ready" }),
  shell({ id: "thread-review", title: "T-1234-review", group: "T-1234" }),
  shell({
    id: "thread-archived",
    title: "T-1234-tests",
    group: "T-1234",
    archivedAt: "2026-01-02T00:00:00.000Z",
  }),
  shell({
    id: "thread-elsewhere",
    title: "T-1234-dev",
    projectId: otherProjectId,
    group: "T-1234",
  }),
];

it.effect("refuses every tool without the orchestration capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("session_list", {}, ["preview"]);
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("capability-unavailable");
    }).pipe(Effect.provide(makeHarness(baseThreads).layer)),
  ),
);

it.effect("lists the caller's project only, skipping archived threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* callTool("session_list", {});
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        sessions: [
          {
            threadId: "thread-orchestrator",
            name: "orchestrator",
            group: null,
            projectId: "project-1",
            project: "t3code",
            status: "running",
            self: true,
          },
          {
            threadId: "thread-dev",
            name: "T-1234-dev",
            group: "T-1234",
            projectId: "project-1",
            project: "t3code",
            status: "ready",
            self: false,
          },
          {
            threadId: "thread-review",
            name: "T-1234-review",
            group: "T-1234",
            projectId: "project-1",
            project: "t3code",
            status: "stopped",
            self: false,
          },
        ],
      });

      const grouped = yield* callTool("session_list", { group: "T-1234" });
      expect((grouped.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(2);
    }).pipe(Effect.provide(makeHarness(baseThreads).layer)),
  ),
);

it.effect("spawns by creating the thread and starting its turn, leaving the caller ungrouped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const result = yield* callTool("session_spawn", {
        name: "T-1234-tests",
        group: "T-1234",
        message: "Session tests. Standby.",
      }).pipe(Effect.provide(harness.layer));

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ name: "T-1234-tests", group: "T-1234" });

      const types = harness.dispatched.map((command) => command.type);
      // One orchestrator drives many tickets, so it must never be pulled
      // into a ticket's group.
      expect(types).toEqual(["thread.create", "thread.turn.start"]);

      const [create, turn] = harness.dispatched;
      expect(create).toMatchObject({
        projectId,
        title: "T-1234-tests",
        group: "T-1234",
        branch: null,
        worktreePath: null,
        runtimeMode: "full-access",
        // No model inputs: an exact copy of the caller's selection.
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
        parentThreadId: callerId,
      });
      expect(result.structuredContent).toMatchObject({ adopted: [] });
      expect(String(create?.commandId)).toMatch(/^server:orchestration-thread-create:/);
      // No titleSeed: the title must never be eligible for auto-replacement.
      expect(turn).not.toHaveProperty("titleSeed");
      expect(turn).toMatchObject({
        message: { role: "user", text: "Session tests. Standby.", attachments: [] },
      });
      if (turn?.type === "thread.turn.start" && create?.type === "thread.create") {
        expect(turn.threadId).toBe(create.threadId);
      }
    }),
  ),
);

it.effect("hands off: the successor is the caller's sibling and takes over its roster", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness([
        shell({
          id: "thread-orchestrator",
          title: "orchestrator",
          parentThreadId: "thread-root",
          status: "running",
        }),
        shell({ id: "thread-dev", title: "T-1234-dev", parentThreadId: "thread-orchestrator" }),
        shell({
          id: "thread-review",
          title: "T-1234-review",
          parentThreadId: "thread-orchestrator",
          settled: true,
        }),
        shell({ id: "thread-other", title: "other", parentThreadId: "thread-root" }),
      ]);
      const result = yield* callTool("session_spawn", {
        name: "orchestrator-2",
        group: "ops",
        message: "Take over from orchestrator.",
        handoff: true,
      }).pipe(Effect.provide(harness.layer));

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        adopted: ["T-1234-dev", "T-1234-review"],
      });
      const [create, turn, ...moves] = harness.dispatched;
      expect(turn?.type).toBe("thread.turn.start");
      // Sibling: settling the old orchestrator must not reach its successor.
      expect(create).toMatchObject({ type: "thread.create", parentThreadId: "thread-root" });
      const successorId = create?.type === "thread.create" ? create.threadId : null;
      expect(moves).toEqual([
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: "thread-dev",
          parentThreadId: successorId,
        }),
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: "thread-review",
          parentThreadId: successorId,
        }),
      ]);
    }),
  ),
);

it.effect("spawns on another provider with its default model when only instanceId is given", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const result = yield* callTool("session_spawn", {
        name: "T-1234-review-codex",
        group: "T-1234",
        message: "Review the diff.",
        instanceId: "codex",
      }).pipe(Effect.provide(harness.layer));

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        instanceId: "codex",
        model: "gpt-5.6",
        options: [],
      });
      const [create, turn] = harness.dispatched;
      // The first turn must run on the same selection the thread was created with,
      // or the provider process starts on the caller's model instead.
      expect(create).toMatchObject({ modelSelection: { instanceId: "codex", model: "gpt-5.6" } });
      expect(turn).toMatchObject({ modelSelection: { instanceId: "codex", model: "gpt-5.6" } });
    }),
  ),
);

it.effect("spawns with a chosen model and effort, and refuses an effort the model lacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const refused = yield* callTool("session_spawn", {
        name: "sonnet-max",
        group: "bakeoff",
        message: "go",
        model: "claude-sonnet-5",
        options: [{ id: "effort", value: "max" }],
      }).pipe(Effect.provide(harness.layer));
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toContain("invalid-model");
      expect(errorText(refused)).toContain("high");
      expect(harness.dispatched).toHaveLength(0);

      const accepted = yield* callTool("session_spawn", {
        name: "sonnet-high",
        group: "bakeoff",
        message: "go",
        model: "claude-sonnet-5",
        options: [{ id: "effort", value: "high" }],
      }).pipe(Effect.provide(harness.layer));
      expect(accepted.isError).toBe(false);
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.create",
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "high" }],
        },
      });
    }),
  ),
);

it.effect("refuses a provider that is unknown or disabled, before touching the engine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      for (const instanceId of ["gemini", "cursor"]) {
        const result = yield* callTool("session_spawn", {
          name: "T-1234-other",
          group: "T-1234",
          message: "go",
          instanceId,
        }).pipe(Effect.provide(harness.layer));
        expect(result.isError).toBe(true);
        expect(errorText(result)).toContain("invalid-model");
        expect(errorText(result)).toContain("claudeAgent, codex");
      }
      expect(harness.dispatched).toHaveLength(0);
    }),
  ),
);

it.effect("lists usable providers with each model's options, marking the caller's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const all = yield* callTool("session_models", {});
      expect(all.isError).toBe(false);
      const { providers } = all.structuredContent as {
        providers: ReadonlyArray<{ instanceId: string; current: boolean }>;
      };
      expect(providers.map((entry) => [entry.instanceId, entry.current])).toEqual([
        ["claudeAgent", true],
        ["codex", false],
      ]);

      const codex = yield* callTool("session_models", { instanceId: "codex" });
      expect(codex.structuredContent).toMatchObject({
        providers: [
          {
            instanceId: "codex",
            models: [
              { slug: "gpt-5.5", isDefault: false },
              {
                slug: "gpt-5.6",
                isDefault: true,
                options: [
                  {
                    id: "effort",
                    type: "select",
                    choices: ["low", "medium", "high"],
                    default: "medium",
                  },
                ],
              },
            ],
          },
        ],
      });
    }).pipe(Effect.provide(makeHarness(baseThreads).layer)),
  ),
);

it.effect("refuses a name that is already open in the project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const result = yield* callTool("session_spawn", {
        name: "T-1234-dev",
        group: "T-1234",
        message: "go",
      }).pipe(Effect.provide(harness.layer));
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("already-exists");
      expect(harness.dispatched).toHaveLength(0);
    }),
  ),
);

it.effect("rejects a malformed name before touching the engine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const malformed = yield* callTool("session_spawn", {
        name: "has space",
        group: "T-1234",
        message: "go",
      }).pipe(Effect.provide(harness.layer), Effect.flip);
      expect(malformed._tag).toBe("InvalidParams");
      expect(harness.dispatched).toHaveLength(0);
    }),
  ),
);

it.effect("deletes the created thread when its first turn fails to start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      harness.failing.add("thread.turn.start");
      const result = yield* callTool("session_spawn", {
        name: "T-1234-tests",
        group: "T-1234",
        message: "go",
      }).pipe(Effect.provide(harness.layer));
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("dispatch-failed");
      expect(harness.dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
        "thread.delete",
      ]);
    }),
  ),
);

it.effect("wakes exactly one matching session and reports zero or many", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const woken = yield* callTool("session_wake", {
        name: "T-1234-review",
        message: "Resume review.",
      }).pipe(Effect.provide(harness.layer));
      expect(woken.isError).toBe(false);
      expect(woken.structuredContent).toEqual({ threadId: "thread-review", name: "T-1234-review" });
      expect(harness.dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
      expect(harness.dispatched[0]).toMatchObject({ threadId: "thread-review" });

      const missing = yield* callTool("session_wake", { name: "nobody", message: "hi" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(missing.isError).toBe(true);
      expect(errorText(missing)).toContain("thread-not-found");

      const ambiguousHarness = makeHarness([
        ...baseThreads,
        shell({ id: "thread-dev-2", title: "T-1234-dev", group: "T-1234" }),
      ]);
      const ambiguous = yield* callTool("session_wake", { name: "T-1234-dev", message: "hi" }).pipe(
        Effect.provide(ambiguousHarness.layer),
      );
      expect(ambiguous.isError).toBe(true);
      expect(errorText(ambiguous)).toContain("ambiguous-name");
      expect(ambiguousHarness.dispatched).toHaveLength(0);
    }),
  ),
);

it.effect("wakes a prose-titled session by the threadId session_list reports", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness([
        ...baseThreads,
        shell({ id: "thread-prose", title: "Create ticket 23.9D." }),
      ]);
      const woken = yield* callTool("session_wake", {
        name: "thread-prose",
        message: "Where are the acceptance criteria?",
      }).pipe(Effect.provide(harness.layer));
      expect(woken.isError).toBe(false);
      expect(woken.structuredContent).toEqual({
        threadId: "thread-prose",
        name: "Create ticket 23.9D.",
      });
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-prose",
      });
    }),
  ),
);

it.effect("leaves settled sessions out of the list, so a group empties as it finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness([
        ...baseThreads,
        shell({ id: "thread-done", title: "T-1234-tests-2", group: "T-1234", settled: true }),
      ]);
      const result = yield* callTool("session_list", { group: "T-1234" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(result.isError).toBe(false);
      const { sessions } = result.structuredContent as {
        sessions: ReadonlyArray<{ name: string }>;
      };
      // Without this an orchestrator polling its group reads the settled row
      // as still running and settles it again on every pass.
      expect(sessions.map((session) => session.name)).toEqual(["T-1234-dev", "T-1234-review"]);
    }),
  ),
);

it.effect("keeps the caller's own row even if the caller is settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness([
        shell({ id: "thread-orchestrator", title: "orchestrator", settled: true }),
        shell({ id: "thread-dev", title: "T-1234-dev", group: "T-1234", settled: true }),
      ]);
      const result = yield* callTool("session_list", {}).pipe(Effect.provide(harness.layer));
      expect(result.structuredContent).toEqual({
        sessions: [
          {
            threadId: "thread-orchestrator",
            name: "orchestrator",
            group: null,
            projectId: "project-1",
            project: "t3code",
            status: "stopped",
            self: true,
          },
        ],
      });
    }),
  ),
);

it.effect("says a settled session is holding a name that spawn cannot reuse", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness([
        ...baseThreads,
        shell({ id: "thread-done", title: "T-1234-docs", group: "T-1234", settled: true }),
      ]);
      const result = yield* callTool("session_spawn", {
        name: "T-1234-docs",
        group: "T-1234",
        message: "go",
      }).pipe(Effect.provide(harness.layer));
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("already-exists");
      expect(errorText(result)).toContain("settled session");
      expect(harness.dispatched).toHaveLength(0);
    }),
  ),
);

it.effect("settles a finished session by name and by threadId", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const byName = yield* callTool("session_settle", { name: "T-1234-review" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(byName.isError).toBe(false);
      expect(byName.structuredContent).toEqual({
        threadId: "thread-review",
        name: "T-1234-review",
      });
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.settle",
        threadId: "thread-review",
      });
      expect(String(harness.dispatched[0]?.commandId)).toMatch(
        /^server:orchestration-thread-settle:/,
      );

      const byId = yield* callTool("session_settle", { name: "thread-dev" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(byId.isError).toBe(false);
      expect(harness.dispatched[1]).toMatchObject({
        type: "thread.settle",
        threadId: "thread-dev",
      });
    }),
  ),
);

it.effect("refuses to settle the caller, which is running by definition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const result = yield* callTool("session_settle", { name: "orchestrator" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("settle-blocked");
      expect(harness.dispatched).toHaveLength(0);
    }),
  ),
);

it.effect("reports the server's settle refusal as settle-blocked, not a dispatch failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      harness.blocking.add("thread.settle");
      const result = yield* callTool("session_settle", { name: "T-1234-dev" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("settle-blocked");
      expect(errorText(result)).not.toContain("dispatch-failed");
    }),
  ),
);

it.effect("reaches another project's session by threadId, while a name stays in the caller's", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const byId = yield* callTool("session_wake", {
        name: "thread-elsewhere",
        message: "hi",
      }).pipe(Effect.provide(harness.layer));
      expect(byId.isError).toBe(false);
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-elsewhere",
      });

      // Both projects hold a T-1234-dev; a bare name must never pick the other one.
      const byName = yield* callTool("session_wake", { name: "T-1234-dev", message: "hi" }).pipe(
        Effect.provide(harness.layer),
      );
      expect(byName.structuredContent).toEqual({ threadId: "thread-dev", name: "T-1234-dev" });
    }),
  ),
);

it.effect("spawns into another project, checking the name against that project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness(baseThreads);
      const clash = yield* callTool("session_spawn", {
        name: "T-1234-dev",
        group: "T-1234",
        message: "go",
        project: "fleet",
      }).pipe(Effect.provide(harness.layer));
      expect(clash.isError).toBe(true);
      expect(errorText(clash)).toContain("already-exists");
      expect(harness.dispatched).toHaveLength(0);

      // Taken in the caller's project, free in fleet, which is named by path here.
      const spawned = yield* callTool("session_spawn", {
        name: "T-1234-review",
        group: "T-1234",
        message: "go",
        project: "C:/source/fleet",
      }).pipe(Effect.provide(harness.layer));
      expect(spawned.isError).toBe(false);
      expect(spawned.structuredContent).toMatchObject({ projectId: "project-2" });
      expect(harness.dispatched[0]).toMatchObject({
        type: "thread.create",
        projectId: "project-2",
        parentThreadId: "thread-orchestrator",
      });

      const missing = yield* callTool("session_spawn", {
        name: "T-1234-docs",
        group: "T-1234",
        message: "go",
        project: "nowhere",
      }).pipe(Effect.provide(harness.layer));
      expect(missing.isError).toBe(true);
      expect(errorText(missing)).toContain("project-not-found");
      expect(errorText(missing)).toContain("t3code, fleet");
    }),
  ),
);

it.effect("lists the projects, then sessions in one other project or in all of them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const projects = yield* callTool("session_projects", {});
      expect(projects.structuredContent).toEqual({
        projects: [
          { projectId: "project-1", name: "t3code", path: "C:/source/t3code", current: true },
          { projectId: "project-2", name: "fleet", path: "C:/source/fleet", current: false },
        ],
      });
      const matched = yield* callTool("session_projects", { match: "FLE" });
      expect(matched.structuredContent).toMatchObject({ projects: [{ projectId: "project-2" }] });
      expect((matched.structuredContent as { projects: unknown[] }).projects).toHaveLength(1);

      const ids = (result: { readonly structuredContent?: unknown }) =>
        (
          result.structuredContent as { sessions: ReadonlyArray<{ threadId: string }> }
        ).sessions.map((session) => session.threadId);
      const fleet = yield* callTool("session_list", { project: "fleet" });
      expect(ids(fleet)).toEqual(["thread-elsewhere"]);
      expect(fleet.structuredContent).toMatchObject({
        sessions: [{ projectId: "project-2", project: "fleet", self: false }],
      });

      const all = yield* callTool("session_list", { project: "*" });
      expect(ids(all)).toEqual([
        "thread-orchestrator",
        "thread-dev",
        "thread-review",
        "thread-elsewhere",
      ]);
    }).pipe(Effect.provide(makeHarness(baseThreads).layer)),
  ),
);
