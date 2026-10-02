import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

// Fork: the session lane, spawner, and handoff successor on v2 threads.

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "fork-fields" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:fork-fields"),
      title: threadId,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("sets, keeps, and clears group, spawner, and successor through metadata updates", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = ThreadId.make("thread:fork-parent");
    const child = ThreadId.make("thread:fork-child");
    const successor = ThreadId.make("thread:fork-successor");
    yield* createThread(parent);
    yield* createThread(child);
    yield* createThread(successor);

    const fresh = yield* projections.getThreadShell(child);
    assert.isNull(fresh?.group);
    assert.isNull(fresh?.spawnedByThreadId);
    assert.isNull(fresh?.successorThreadId);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("fork-set"),
      threadId: child,
      group: "lane-a",
      spawnedByThreadId: parent,
      successorThreadId: successor,
    });
    const set = yield* projections.getThread(child);
    assert.equal(set.group, "lane-a");
    assert.equal(set.spawnedByThreadId, parent);
    assert.equal(set.successorThreadId, successor);
    const shell = yield* projections.getThreadShell(child);
    assert.equal(shell?.group, "lane-a");
    assert.equal(shell?.spawnedByThreadId, parent);
    assert.equal(shell?.successorThreadId, successor);
    const snapshot = yield* projections.getShellSnapshot();
    assert.equal(snapshot.threads.find((thread) => thread.id === child)?.group, "lane-a");

    // An update that omits the fields leaves them alone.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("fork-rename"),
      threadId: child,
      title: "Renamed",
    });
    const renamed = yield* projections.getThread(child);
    assert.equal(renamed.title, "Renamed");
    assert.equal(renamed.group, "lane-a");
    assert.equal(renamed.spawnedByThreadId, parent);
    assert.equal(renamed.successorThreadId, successor);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("fork-clear"),
      threadId: child,
      group: null,
      spawnedByThreadId: null,
      successorThreadId: null,
    });
    const cleared = yield* projections.getThreadShell(child);
    assert.isNull(cleared?.group);
    assert.isNull(cleared?.spawnedByThreadId);
    assert.isNull(cleared?.successorThreadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a spawner or successor that is the thread itself, missing, or deleted", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = ThreadId.make("thread:fork-target");
    const deleted = ThreadId.make("thread:fork-deleted");
    yield* createThread(thread);
    yield* createThread(deleted);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("fork-delete"),
      threadId: deleted,
    });

    const refused = [
      { spawnedByThreadId: thread },
      { successorThreadId: thread },
      { spawnedByThreadId: ThreadId.make("thread:fork-missing") },
      { successorThreadId: ThreadId.make("thread:fork-missing") },
      { spawnedByThreadId: deleted },
    ];
    for (const [index, fields] of refused.entries()) {
      const exit = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`fork-refused-${index}`),
          threadId: thread,
          group: "lane-b",
          ...fields,
        }),
      );
      assert.isTrue(Exit.isFailure(exit), `update ${index} should be refused`);
    }
    // A refused update applies nothing, not even its group.
    const unchanged = yield* projections.getThread(thread);
    assert.isUndefined(unchanged.group);
    assert.isUndefined(unchanged.spawnedByThreadId);
    assert.isUndefined(unchanged.successorThreadId);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("settles a spawned session under its own lock, after the parent's settle", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const parent = ThreadId.make("thread:cascade-parent");
    const child = ThreadId.make("thread:cascade-child");
    yield* createThread(parent);
    yield* createThread(child);
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("cascade-spawner"),
      threadId: child,
      spawnedByThreadId: parent,
    });

    // Something else (a wake, say) holds the child's lock.
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* executor
      .withLock(
        child,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(held);

    const settle = yield* orchestrator
      .dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cascade-settle"),
        threadId: parent,
      })
      .pipe(Effect.forkChild);
    let attempts = 0;
    while ((yield* projections.getThread(parent)).settledOverride !== "settled") {
      assert.isBelow(++attempts, 10_000, "the parent's settle never committed");
      yield* Effect.yieldNow;
    }
    // The parent committed without the child's lock; the child waits for it.
    assert.isNull((yield* projections.getThread(child)).settledOverride);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(settle);
    assert.equal((yield* projections.getThread(child)).settledOverride, "settled");

    // A retried settle replays the child's receipt instead of settling it again.
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("cascade-reopen"),
      threadId: child,
      reason: "user",
    });
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("cascade-settle"),
      threadId: parent,
    });
    assert.notEqual((yield* projections.getThread(child)).settledOverride, "settled");
  }).pipe(Effect.provide(Layer.merge(testLayer, ThreadCommandExecutor.layer))),
);
