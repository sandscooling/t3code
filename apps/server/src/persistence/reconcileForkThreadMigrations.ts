import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// v1 fork builds recorded their thread columns as migrations 55 and 56, the
// ids upstream later gave OrchestrationV2 and RemoveRedundantProjectionIndexes.
// The migrator skips any id at or below the ledger's max, so a copied fork
// database would never get the V2 schema. Drop exactly those two rows so
// upstream's 55 and 56 run. The columns stay: nullable, and read only by the
// legacy importer. This runs on statev2.sqlite; state.sqlite is never opened
// read-write, so a v1 rollback still finds its own ledger.
const forkLedgerRows = [
  [55, "ProjectionThreadsGroupKey"],
  [56, "ProjectionThreadsParentThreadId"],
] as const;

/** Returns the fork ledger rows it removed, as `[id, name]`. */
export const reconcileForkThreadMigrations = Effect.fn("reconcileForkThreadMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const removed: Array<readonly [number, string]> = [];
        for (const [id, name] of forkLedgerRows) {
          const rows = yield* sql`
            DELETE FROM effect_sql_migrations
            WHERE migration_id = ${id} AND name = ${name}
            RETURNING migration_id
          `;
          if (rows.length > 0) removed.push([id, name]);
        }
        if (removed.length > 0) {
          yield* Effect.log("Removed fork migration ledger rows before V2 migrations").pipe(
            Effect.annotateLogs({ removed: removed.map(([id, name]) => `${id}_${name}`) }),
          );
        }
        return removed;
      }),
    );
  },
);
