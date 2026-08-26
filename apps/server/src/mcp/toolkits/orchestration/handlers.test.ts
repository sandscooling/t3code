import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  readonly archivedAt?: string | null;
  readonly status?: "running" | "ready" | "stopped";
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
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
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

class RefusedByTest extends Data.TaggedError("RefusedByTest")<{ readonly message: string }> {}

/**
 * Stub engine that records what was dispatched and can be told to fail a
 * given command type once.
 */
function makeHarness(threads: ReadonlyArray<OrchestrationThreadShell>) {
  const dispatched: Array<OrchestrationCommand> = [];
  const failing = new Set<OrchestrationCommand["type"]>();
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        dispatched.push(command);
        if (failing.has(command.type)) {
          failing.delete(command.type);
          return Effect.fail(
            new RefusedByTest({ message: `dispatch of ${command.type} refused by test` }),
          );
        }
        return Effect.succeed({ sequence: dispatched.length });
      }),
  } as unknown as OrchestrationEngineShape;
  const query = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [],
        threads,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
  } as unknown as ProjectionSnapshotQueryShape;

  const layer = McpHttpServer.OrchestrationToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provideMerge(NodeServices.layer),
  );
  return { dispatched, failing, layer };
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
          { threadId: "thread-orchestrator", name: "orchestrator", group: null, status: "running" },
          { threadId: "thread-dev", name: "T-1234-dev", group: "T-1234", status: "ready" },
          { threadId: "thread-review", name: "T-1234-review", group: "T-1234", status: "stopped" },
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
      });
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
