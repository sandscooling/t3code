import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { reconcileForkThreadMigrations } from "./reconcileForkThreadMigrations.ts";

interface LedgerRow {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
}

const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<LedgerRow>`
    SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
  `;
});

// A v1 fork database as the live one is: upstream 1-54, then the fork's 55 and 56.
const seedForkV1 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-01-01 00:00:00'`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN group_key TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
      (55, 'ProjectionThreadsGroupKey', '2026-01-01 00:00:00'),
      (56, 'ProjectionThreadsParentThreadId', '2026-01-01 00:00:00')
  `;
});

describe("fork migration ledger reconcile", () => {
  it.effect("drops the fork's 55 and 56 so V2's 55 and 56 run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkV1;
      const upstreamRows = (yield* ledger).filter((row) => row.migration_id <= 54);

      assert.deepStrictEqual(yield* runMigrations(), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const history = yield* ledger;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      // Every row the fork shares with upstream is untouched, timestamps included.
      assert.deepStrictEqual(
        history.filter((row) => row.migration_id <= 54),
        upstreamRows,
      );
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'`,
        1,
      );
      // The fork's columns stay for the legacy importer.
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "group_key"));
      assert.ok(columns.some((column) => column.name === "parent_thread_id"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("removes only rows matching both the fork id and the fork name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (55, 'SomeOtherFork'),
          (56, 'ProjectionThreadsParentThreadId'),
          (57, 'ProjectionThreadsGroupKey')
      `;
      const before = yield* ledger;

      assert.deepStrictEqual(yield* reconcileForkThreadMigrations(), [
        [56, "ProjectionThreadsParentThreadId"],
      ]);
      assert.deepStrictEqual(
        yield* ledger,
        before.filter((row) => row.migration_id !== 56),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is a no-op on an upstream database and on an empty one", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* reconcileForkThreadMigrations(), []);
      yield* runMigrations();
      const before = yield* ledger;
      assert.deepStrictEqual(yield* reconcileForkThreadMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
