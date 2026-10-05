import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";
import { settleSpawnedThreads, spawnedThreadIdsOf } from "./spawnedSessions.ts";

const parent = ThreadId.make("thread:parent");
const settledAt = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

// Children by id, with their settledOverride; an id missing here is not found.
const makeHarness = (
  children: ReadonlyArray<readonly [string, "settled" | "active" | null]>,
  dispatch: (threadId: ThreadId) => Effect.Effect<void, string> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const overrides = new Map(children.map(([id, override]) => [ThreadId.make(id), override]));
    const dispatched: Array<unknown> = [];
    const dispatchedIds: Array<ThreadId> = [];
    const locked: Array<ThreadId> = [];
    const executor = yield* KeyedLock.make<ThreadId>();
    const deps = {
      projectionStore: {
        getSpawnedThreadIds: () =>
          Effect.succeed([...children.map(([id]) => ThreadId.make(id)), ThreadId.make("gone")]),
        getThread: (threadId: ThreadId) => {
          const override = overrides.get(threadId);
          return override === undefined
            ? Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }))
            : Effect.succeed({ settledOverride: override } as unknown as OrchestrationV2AppThread);
        },
      },
      threadDispatch: {
        withLock: <A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) =>
          executor.withLock(key, Effect.sync(() => locked.push(key)).pipe(Effect.andThen(effect))),
      },
      dispatchWithReceipt: (command: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          dispatched.push(command);
          dispatchedIds.push(command.threadId);
        }).pipe(Effect.andThen(dispatch(command.threadId))),
    };
    return { deps, dispatched, dispatchedIds, locked };
  });

const settle = {
  type: "thread.settle",
  commandId: CommandId.make("settle-parent"),
  threadId: parent,
  settledAt,
} as const;

it.effect("settles each open child as its own command under its own lock", () =>
  Effect.gen(function* () {
    const { deps, dispatched, locked } = yield* makeHarness([
      ["child-a", null],
      ["child-b", "settled"],
      ["child-c", "active"],
    ]);
    yield* settleSpawnedThreads(deps, settle);
    assert.deepStrictEqual(
      locked,
      ["child-a", "child-b", "child-c", "gone"].map((id) => ThreadId.make(id)),
    );
    // An already settled child and a missing one are skipped.
    assert.deepStrictEqual(dispatched, [
      {
        type: "thread.settle",
        commandId: "settle-parent:spawned:child-a",
        threadId: ThreadId.make("child-a"),
        settledAt,
      },
      {
        type: "thread.settle",
        commandId: "settle-parent:spawned:child-c",
        threadId: ThreadId.make("child-c"),
        settledAt,
      },
    ]);
  }),
);

it.effect("never cascades an automatic settle or any other command", () =>
  Effect.gen(function* () {
    const { deps, locked } = yield* makeHarness([["child-a", null]]);
    yield* settleSpawnedThreads(deps, {
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle-parent"),
      threadId: parent,
      snapshotAt: settledAt,
    });
    yield* settleSpawnedThreads(deps, {
      type: "thread.unsettle",
      commandId: CommandId.make("reopen-parent"),
      threadId: parent,
      reason: "user",
    });
    assert.deepStrictEqual(locked, []);
  }),
);

it.effect("a child the settle guard refuses stays open and the rest still settle", () =>
  Effect.gen(function* () {
    const { deps, dispatchedIds } = yield* makeHarness(
      [
        ["child-a", null],
        ["child-b", null],
      ],
      (threadId) => (threadId === "child-a" ? Effect.fail("child-a is busy") : Effect.void),
    );
    yield* settleSpawnedThreads(deps, settle);
    assert.deepStrictEqual(dispatchedIds, [ThreadId.make("child-a"), ThreadId.make("child-b")]);
  }),
);

it.effect("an interrupted request cannot stop the cascade halfway", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { deps, dispatchedIds } = yield* makeHarness(
      [
        ["child-a", null],
        ["child-b", null],
      ],
      (threadId) =>
        threadId === "child-a"
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
    );
    const cascade = yield* settleSpawnedThreads(deps, settle).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const interrupter = yield* Fiber.interrupt(cascade).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupter);
    assert.deepStrictEqual(dispatchedIds, [ThreadId.make("child-a"), ThreadId.make("child-b")]);
  }),
);

it("lists only the live threads a thread spawned, in id order", () => {
  const thread = (id: string, spawnedByThreadId: ThreadId | null | undefined, gone = false) => ({
    id: ThreadId.make(id),
    spawnedByThreadId,
    archivedAt: id === "archived" && gone ? settledAt : null,
    deletedAt: id === "deleted" && gone ? settledAt : null,
  });
  assert.deepStrictEqual(
    spawnedThreadIdsOf(
      [
        thread("b", parent),
        thread("a", parent),
        thread("archived", parent, true),
        thread("deleted", parent, true),
        thread("other", ThreadId.make("thread:other")),
        thread("unset", undefined),
      ],
      parent,
    ),
    ["a", "b"].map((id) => ThreadId.make(id)),
  );
});
