/**
 * Fork-owned: the sessions a thread spawned (`spawnedByThreadId`), and the
 * settle cascade that closes them with their spawner. Orchestrator.ts and
 * ProjectionStore.ts reach this through one marked hook each.
 */
import {
  CommandId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { KeyedLock } from "@t3tools/shared/KeyedLock";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

/** The live threads whose spawnedByThreadId is `threadId`, from the SQL projection. */
export const querySpawnedThreadIds = Effect.fn("ProjectionStore.getSpawnedThreadIds")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND archived_at IS NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.spawnedByThreadId') = ${threadId}
        ELSE 0 END
    ORDER BY thread_id ASC
  `;
  return rows.map((row) => ThreadId.make(row.thread_id));
});

/** The in-memory twin of querySpawnedThreadIds. */
export const spawnedThreadIdsOf = (
  threads: Iterable<
    Pick<OrchestrationV2AppThread, "id" | "spawnedByThreadId" | "archivedAt" | "deletedAt">
  >,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> =>
  [...threads]
    .filter(
      (thread) =>
        thread.spawnedByThreadId === threadId &&
        thread.archivedAt === null &&
        thread.deletedAt === null,
    )
    .map((thread) => thread.id)
    .toSorted((left, right) => left.localeCompare(right));

type SettleCommand = Extract<OrchestrationV2ServerCommand, { readonly type: "thread.settle" }>;

/**
 * An explicit settle also settles the sessions this thread spawned, one level
 * deep, as v1 did. Each child settles as its own command under its own lock
 * once the parent's settle has committed and released its lock, so a
 * concurrent wake on a child is ordered against that settle rather than
 * overwritten by it. A child the settle guard refuses (active or blocked work)
 * stays open. A retried parent replays each child's receipt. Automatic
 * settlement is thread.auto-settle and never cascades.
 *
 * Run it after the parent's dispatch has returned (outside its lock). It is
 * uninterruptible, so a cancelled request cannot stop it halfway, and it never
 * fails: a broken cascade is logged.
 */
export const settleSpawnedThreads = <E>(
  deps: {
    readonly projectionStore: Pick<ProjectionStoreV2Shape, "getSpawnedThreadIds" | "getThread">;
    readonly threadDispatch: Pick<KeyedLock<ThreadId>, "withLock">;
    readonly dispatchWithReceipt: (command: SettleCommand) => Effect.Effect<unknown, E>;
  },
  command: OrchestrationV2ServerCommand,
): Effect.Effect<void> =>
  command.type !== "thread.settle"
    ? Effect.void
    : Effect.uninterruptible(
        Effect.gen(function* () {
          const childIds = yield* deps.projectionStore.getSpawnedThreadIds(command.threadId);
          for (const childId of childIds) {
            yield* deps.threadDispatch
              .withLock(
                childId,
                Effect.gen(function* () {
                  const child = yield* deps.projectionStore.getThread(childId).pipe(Effect.option);
                  if (Option.isNone(child) || child.value.settledOverride === "settled") return;
                  yield* deps.dispatchWithReceipt({
                    type: "thread.settle",
                    commandId: CommandId.make(`${command.commandId}:spawned:${childId}`),
                    threadId: childId,
                    ...(command.settledAt === undefined ? {} : { settledAt: command.settledAt }),
                  });
                }),
              )
              .pipe(Effect.ignore);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to settle spawned sessions", {
              threadId: command.threadId,
              cause,
            }),
          ),
        ),
      );
