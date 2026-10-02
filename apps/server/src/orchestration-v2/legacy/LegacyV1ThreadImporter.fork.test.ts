import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

// Fork: the v1 fork's group_key and parent_thread_id columns carry into v2.
// Each test provides its own layer, so each gets a fresh database.

const databaseLayer = SqlitePersistenceMemory;
const storesProvided = Layer.mergeAll(
  databaseLayer,
  EventStore.layer.pipe(Layer.provideMerge(databaseLayer)),
  ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer)),
);
const eventSinkProvided = EventSink.layer.pipe(Layer.provide(storesProvided));
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
  ),
);

const insertProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:fork-import', 'Fork project', '/tmp/fork-import', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
});

const insertThread = (threadId: string, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:fork-import', ${threadId},
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        ${createdAt}, ${createdAt}
      )
    `;
  });

it.effect("imports group and spawner from a v1 fork database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // What the fork's v1 migrations 55 and 56 added.
    yield* sql`ALTER TABLE projection_threads ADD COLUMN group_key TEXT`;
    yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
    yield* insertProject;
    // The child is older than its spawner, so import order cannot matter.
    yield* insertThread("thread:fork-child", "2026-01-01T00:00:00.000Z");
    yield* insertThread("thread:fork-orchestrator", "2026-01-02T00:00:00.000Z");
    yield* insertThread("thread:fork-loose", "2026-01-03T00:00:00.000Z");
    yield* insertThread("thread:fork-self", "2026-01-04T00:00:00.000Z");
    yield* sql`
      UPDATE projection_threads SET group_key = 'lane-a', parent_thread_id = 'thread:fork-orchestrator'
      WHERE thread_id = 'thread:fork-child'
    `;
    yield* sql`
      UPDATE projection_threads SET group_key = ' lane-a ' WHERE thread_id = 'thread:fork-orchestrator'
    `;
    yield* sql`
      UPDATE projection_threads SET group_key = '  ', parent_thread_id = 'thread:fork-self'
      WHERE thread_id = 'thread:fork-self'
    `;

    assert.deepStrictEqual(yield* importer.reconcileShells, {
      importedThreadCount: 4,
      importedMessageCount: 0,
    });

    const imported = new Map(
      yield* Effect.forEach(
        ["thread:fork-child", "thread:fork-orchestrator", "thread:fork-loose", "thread:fork-self"],
        (id) =>
          projections
            .getThread(ThreadId.make(id))
            .pipe(Effect.map((thread) => [id, [thread.group, thread.spawnedByThreadId]] as const)),
      ),
    );
    assert.deepStrictEqual(Object.fromEntries(imported), {
      "thread:fork-child": ["lane-a", ThreadId.make("thread:fork-orchestrator")],
      "thread:fork-orchestrator": ["lane-a", null],
      "thread:fork-loose": [null, null],
      // Blank lanes and self-links are dropped.
      "thread:fork-self": [null, null],
    });
    const shell = yield* projections.getThreadShell(ThreadId.make("thread:fork-child"));
    assert.equal(shell?.group, "lane-a");
    assert.equal(shell?.spawnedByThreadId, "thread:fork-orchestrator");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("imports a v1 database without the fork columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.isFalse(columns.some((column) => column.name === "group_key"));
    assert.isFalse(columns.some((column) => column.name === "parent_thread_id"));
    yield* insertProject;
    yield* insertThread("thread:upstream", "2026-01-01T00:00:00.000Z");

    assert.deepStrictEqual(yield* importer.reconcileShells, {
      importedThreadCount: 1,
      importedMessageCount: 0,
    });
    const thread = yield* projections.getThread(ThreadId.make("thread:upstream"));
    assert.isNull(thread.group);
    assert.isNull(thread.spawnedByThreadId);
  }).pipe(Effect.provide(TestLayer)),
);
