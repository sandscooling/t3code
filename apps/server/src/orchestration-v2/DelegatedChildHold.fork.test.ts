import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { HOLD_END_WAKE_GRACE, makeChildHoldGrace } from "./DelegatedChildHold.fork.ts";

type Grace = Effect.Success<ReturnType<typeof makeChildHoldGrace<never>>>;
type Records = Parameters<Grace["gate"]>[0];
type Progress = Parameters<Grace["gate"]>[1];

const earlierRun = { id: "run:earlier", ordinal: 1, status: "completed" };
const latestRun = { id: "run:latest", ordinal: 2, status: "completed" };
const stopOn = (run: { readonly id: string }) => ({ type: "run_interrupt_request", runId: run.id });
const runningItem = (id: string) => ({
  id,
  type: "command_execution",
  status: "running",
  title: null,
});
const records = (input: {
  readonly held?: ReadonlyArray<string>;
  readonly roster?: ReadonlyArray<string>;
  readonly items?: ReadonlyArray<object>;
}) =>
  ({
    thread: {
      id: "thread:child",
      providerInstanceId: "codex",
      ...(input.held === undefined ? {} : { heldBackgroundTaskIds: input.held }),
    },
    runs: [earlierRun, latestRun],
    providerThreads: [
      {
        pendingBackgroundTasks: (input.roster ?? []).map((taskId) => ({ taskId, kind: "command" })),
      },
    ],
    turnItems: input.items ?? [],
  }) as unknown as Records;

const makeGrace = (
  seeded: Records,
  onWrite: (event: Omit<OrchestrationV2DomainEvent, "id">) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  makeChildHoldGrace<never>({
    eventSink: { stream: () => Stream.never },
    projectionStore: {
      getThread: () => Effect.succeed(seeded.thread),
      getThreadRecords: ((_: string, __: unknown, filter: { turnItemTypes: Array<string> }) =>
        Effect.succeed({
          ...seeded,
          turnItems: seeded.turnItems.filter((item) => filter.turnItemTypes.includes(item.type)),
        })) as never,
    },
    threadDispatch: { withLock: (_, effect) => effect },
    writeSystemEvents: (events) => Effect.forEach(events, onWrite, { discard: true }),
  });

it.effect.each([
  ["no hold", {}, "result_available"],
  ["a held command still running", { held: ["sleep"], roster: ["sleep"] }, "result_available"],
  [
    "a held item still running",
    { held: ["bench"], items: [runningItem("bench")] },
    "result_available",
  ],
  ["an ended hold", { held: ["sleep"] }, "waiting_for_children"],
  ["a Stop on the latest run", { held: ["sleep"], items: [stopOn(latestRun)] }, "result_available"],
  [
    "a Stop on an earlier run only",
    { held: ["sleep"], items: [stopOn(earlierRun)] },
    "waiting_for_children",
  ],
] as const)("gate with %s", ([, input, state]) =>
  Effect.gen(function* () {
    const seeded = records(input);
    const grace = yield* makeGrace(seeded);
    const progress = { state: "result_available" } as unknown as Progress;
    assert.equal((yield* grace.gate(seeded, progress)).state, state);
  }),
);

it.effect("a gated finalize with no event still ends the grace, and keeps a running command", () =>
  Effect.gen(function* () {
    const seeded = records({ held: ["sleep", "dev"], roster: ["dev"] });
    const written = yield* Deferred.make<Omit<OrchestrationV2DomainEvent, "id">>();
    const grace = yield* makeGrace(seeded, (event) =>
      Deferred.succeed(written, event).pipe(Effect.asVoid),
    );
    yield* grace.run(0);
    yield* grace.gate(seeded, { state: "result_available" } as unknown as Progress);
    yield* TestClock.adjust(HOLD_END_WAKE_GRACE);
    const event = yield* Deferred.await(written);
    assert.equal(event.type, "thread.background-work-held");
    assert.deepEqual(
      (event.payload as { readonly heldBackgroundTaskIds?: unknown }).heldBackgroundTaskIds,
      ["dev"],
    );
  }),
);
