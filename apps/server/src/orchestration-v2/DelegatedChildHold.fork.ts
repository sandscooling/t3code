import type { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import {
  RUNNING_COMMAND_ITEMS,
  runningHeldTaskIds,
  turnItemUpdateCanEndBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as EventSink from "./EventSink.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import type * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

// Claude only, n=35: a wake's run follows its command leaving the roster by 60 to 210 ms, median
// 120. Codex is unmeasured.
export const HOLD_END_WAKE_GRACE = Duration.seconds(5);

type HoldRecords = ProjectionStore.ProjectionRecords<"providerThreads" | "runs" | "turnItems">;

const holdEnded = (records: HoldRecords) =>
  runningHeldTaskIds(records).length < (records.thread.heldBackgroundTaskIds?.length ?? 0);

/**
 * Fork: a held id whose command stopped running is a hold end, and its wake may not be a run yet.
 * Until the grace trims the id, `gate` holds back every finalize and status read. The trim is the
 * same event as a release, so it wakes everyone. No state outlives the process: at boot a gated
 * finalize kicks a fresh grace.
 */
export const makeChildHoldGrace = Effect.fn("DelegatedChildHold.makeChildHoldGrace")(function* <
  E,
>(deps: {
  readonly eventSink: Pick<EventSink.EventSinkV2["Service"], "stream">;
  readonly projectionStore: Pick<
    ProjectionStore.ProjectionStoreV2["Service"],
    "getThread" | "getThreadRecords"
  >;
  readonly threadDispatch: Pick<ThreadCommandExecutor.ThreadCommandExecutor["Service"], "withLock">;
  readonly writeSystemEvents: (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
  ) => Effect.Effect<void, E>;
}) {
  const { eventSink, projectionStore, threadDispatch, writeSystemEvents } = deps;
  const kicks = yield* Queue.unbounded<ThreadId>();
  const inGrace = new Set<ThreadId>();

  const holdRecords = (threadId: ThreadId) =>
    projectionStore.getThreadRecords(
      threadId,
      ["providerThreads", "runs", "turnItems"],
      RUNNING_COMMAND_ITEMS,
    );

  // Stop writes this marker no later than any roster clear it causes, and no wake follows it.
  const stopReachedLatestRun = (threadId: ThreadId) =>
    projectionStore
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
      })
      .pipe(
        Effect.map(({ runs, turnItems }) => {
          const latest = runs.findLast((run) => run.status !== "queued");
          return latest !== undefined && turnItems.some((item) => item.runId === latest.id);
        }),
      );

  const gate = Effect.fn("DelegatedChildHold.gate")(function* (
    records: HoldRecords,
    progress: ReturnType<typeof delegatedTaskProgress>,
  ) {
    if (
      progress.state !== "result_available" ||
      !holdEnded(records) ||
      (yield* stopReachedLatestRun(records.thread.id))
    ) {
      return progress;
    }
    yield* Queue.offer(kicks, records.thread.id);
    return { ...progress, state: "waiting_for_children" as const };
  });

  const untilGraceEnds = Effect.fnUntraced(function* (endedAt: DateTime.Utc) {
    const deadline = DateTime.toEpochMillis(endedAt) + Duration.toMillis(HOLD_END_WAKE_GRACE);
    // A sleep can wake a little early, and the trim must not beat the deadline.
    for (;;) {
      const left = deadline - DateTime.toEpochMillis(yield* DateTime.now);
      if (left <= 0) return;
      yield* Effect.sleep(Duration.millis(left));
    }
  });

  // Under the thread's lock: a wait being held at the same moment rewrites the same list.
  const trim = (threadId: ThreadId) =>
    threadDispatch.withLock(
      threadId,
      Effect.gen(function* () {
        const records = yield* holdRecords(threadId);
        if (!holdEnded(records)) return;
        const { thread } = records;
        const running = runningHeldTaskIds(records);
        const { heldBackgroundTaskIds: _ended, ...released } = thread;
        yield* writeSystemEvents([
          {
            type: "thread.background-work-held",
            threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload:
              running.length === 0 ? released : { ...thread, heldBackgroundTaskIds: running },
          },
        ]);
      }),
    );

  const settle = Effect.fn("DelegatedChildHold.settle")(function* (
    threadId: ThreadId,
    endedAt: DateTime.Utc,
  ) {
    const thread = yield* projectionStore.getThread(threadId);
    if ((thread.heldBackgroundTaskIds?.length ?? 0) === 0) return;
    if (!holdEnded(yield* holdRecords(threadId))) return;
    if (!(yield* stopReachedLatestRun(threadId))) {
      if (inGrace.has(threadId)) return;
      inGrace.add(threadId);
      yield* untilGraceEnds(endedAt).pipe(
        Effect.ensuring(Effect.sync(() => inGrace.delete(threadId))),
      );
    }
    yield* trim(threadId);
  });

  /** Graces run concurrently and take no lock, so one never delays another thread. */
  const run = (afterSequence: number) =>
    Stream.mergeAll(
      [
        eventSink.stream({ afterSequence, eventType: "provider-thread.updated" }),
        // Filtered here, so a blocked consumer never buffers unrelated tool bodies.
        eventSink
          .stream({ afterSequence, eventType: "turn-item.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "turn-item.updated" &&
                (event.payload.type === "run_interrupt_request" ||
                  (event.payload.type === "command_execution" &&
                    turnItemUpdateCanEndBackgroundWork(event.payload))),
            ),
          ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.map(({ event }) => ({ threadId: event.threadId, endedAt: event.occurredAt })),
      Stream.merge(
        Stream.fromQueue(kicks).pipe(
          Stream.mapEffect((threadId) =>
            Effect.map(DateTime.now, (endedAt) => ({ threadId, endedAt })),
          ),
        ),
      ),
      Stream.mapEffect(
        ({ threadId, endedAt }) =>
          settle(threadId, endedAt).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to end a background hold", { threadId, cause }),
            ),
          ),
        { concurrency: "unbounded", unordered: true },
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );

  /** A trim that empties a hold reads the same as a release: the finalize both of them owe. */
  const releases = (afterSequence: number) =>
    eventSink
      .stream({ afterSequence, eventType: "thread.background-work-held" })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "thread.background-work-held" &&
            event.payload.heldBackgroundTaskIds === undefined,
        ),
      );

  return { gate, run, releases };
});
