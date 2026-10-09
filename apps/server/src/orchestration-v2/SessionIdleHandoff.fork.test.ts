import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SessionIdleHandoff from "./SessionIdleHandoff.fork.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// Fork: the idle handoff sweep on a real v2 orchestrator with an in-memory
// database. The effect worker is off, so a reminder's run stays preparing,
// which is what a session busy with its handoff turn looks like.

const projectId = ProjectId.make("project:idle");
const claude = ProviderInstanceId.make("claudeAgent");
const model = { instanceId: claude, model: "claude-opus-5" };
const setting = { afterMinutes: 50, minTokens: 200_000 };

const MINUTE = 60_000;
const start = Date.parse("2026-10-09T06:00:00.000Z");
const at = (minutes: number) => DateTime.makeUnsafe(start + minutes * MINUTE);

const adapter = {
  instanceId: claude,
  driver: ProviderDriverKind.make(claude),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider processes never start in these tests"),
} as ProviderAdapterV2Shape;

const database = SqlitePersistence.layerMemory;
const base = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry(
        { name: "idle-handoff" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
  database,
);

/**
 * One server lifetime of the service: a fresh build, with nothing in memory,
 * as after a restart. `sweep` runs the work it registered with the scheduler.
 */
const lifetime = <A, E, R>(
  body: (
    service: SessionIdleHandoff.SessionIdleHandoffService["Service"],
    sweep: Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
) => {
  const sweeps: Array<Effect.Effect<void, SessionIdleHandoff.IdleHandoffStoreError>> = [];
  const scheduler = Layer.mock(Scheduler.Scheduler)({
    register: (_name, work) =>
      Effect.sync(() => {
        sweeps.push(
          work as unknown as Effect.Effect<void, SessionIdleHandoff.IdleHandoffStoreError>,
        );
      }),
  });
  return Effect.gen(function* () {
    const service = yield* SessionIdleHandoff.SessionIdleHandoffService;
    const sweep = Effect.suspend(() => sweeps[0]!).pipe(Effect.orDie);
    return yield* body(service, sweep);
  }).pipe(Effect.provide(SessionIdleHandoff.layer.pipe(Layer.provide(scheduler))));
};

let commandCount = 0;
const dispatch = (command: (commandId: CommandId) => OrchestrationV2ServerCommand) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    commandCount += 1;
    yield* threads.dispatch(command(CommandId.make(`test:${commandCount}`)));
  });

const seedThread = (id: string) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(id);
    yield* dispatch((commandId) => ({
      type: "thread.create",
      commandId,
      threadId,
      projectId,
      title: id,
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }));
    return threadId;
  });

const providerThread = (
  threadId: ThreadId,
  occurredAt: DateTime.Utc,
  pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [],
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`${threadId}:provider-thread:${DateTime.toEpochMillis(occurredAt)}`),
  type: "provider-thread.updated",
  threadId,
  occurredAt,
  payload: {
    id: ProviderThreadId.make(`provider-thread:${threadId}`),
    driver: ProviderDriverKind.make(claude),
    providerInstanceId: claude,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  },
});

/**
 * A run in `status`, as a provider leaves it. A completed one ends at
 * `endsAt` with its provider turn reporting `usedTokens` of context.
 */
const turn = (
  threadId: ThreadId,
  input: {
    readonly ordinal: number;
    readonly endsAt: DateTime.Utc;
    readonly usedTokens?: number;
    readonly status?: "completed" | "failed" | "running" | "queued";
  },
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const status = input.status ?? "completed";
    const key = `${threadId}:${input.ordinal}`;
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const done = status === "completed" || status === "failed";
    const events: Array<OrchestrationV2DomainEvent> = [
      providerThread(threadId, input.endsAt),
      {
        id: EventId.make(`${key}:run`),
        type: "run.created",
        threadId,
        occurredAt: input.endsAt,
        payload: {
          id: RunId.make(`run:${key}`),
          threadId,
          ordinal: input.ordinal,
          providerInstanceId: claude,
          modelSelection: model,
          providerThreadId: status === "queued" ? null : providerThreadId,
          userMessageId: MessageId.make(`message:${key}`),
          rootNodeId: null,
          activeAttemptId: null,
          status,
          ...(status === "queued" ? { queuePosition: 1, queueHeld: true } : {}),
          requestedAt: input.endsAt,
          startedAt: status === "queued" ? null : input.endsAt,
          completedAt: done ? input.endsAt : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ];
    if (status !== "queued") {
      events.push({
        id: EventId.make(`${key}:provider-turn`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: input.endsAt,
        payload: {
          id: ProviderTurnId.make(`provider-turn:${key}`),
          providerThreadId,
          nodeId: NodeId.make(`node:${key}`),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: input.ordinal,
          status,
          startedAt: input.endsAt,
          completedAt: done ? input.endsAt : null,
          ...(input.usedTokens === undefined
            ? {}
            : {
                tokenUsage: {
                  usedTokens: input.usedTokens,
                  updatedAt: DateTime.formatIso(input.endsAt),
                },
              }),
        },
      });
    }
    yield* sink.write({ events });
  });

/** The idle handoff messages posted into a thread, oldest first. */
const reminders = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"]);
    return messages.filter((message) => message.id.startsWith("idle-handoff:"));
  });

/** Finishes the run a reminder started, as the provider would at `endsAt`. */
const finishReminderRun = (threadId: ThreadId, endsAt: DateTime.Utc) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const [message] = (yield* reminders(threadId)).slice(-1);
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    const run = runs.find((candidate) => candidate.id === message?.runId);
    expect(run).toBeDefined();
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${run!.id}:finished`),
          type: "run.updated",
          threadId,
          occurredAt: endsAt,
          payload: { ...run!, status: "completed", startedAt: endsAt, completedAt: endsAt },
        },
      ],
    });
  });

const clockAt = (minutes: number) => TestClock.setTime(start + minutes * MINUTE);

it.effect("posts one reminder once the session has been idle past the window above the line", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:orchestrator");
      yield* service.set(threadId, setting);
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });

      yield* clockAt(49);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(0);

      yield* clockAt(51);
      yield* sweep;
      const [reminder, ...rest] = yield* reminders(threadId);
      expect(rest).toHaveLength(0);
      expect(reminder?.text).toContain("IDLE HANDOFF");
      expect(reminder?.text).toContain("idle for 51 minutes at 250k context");
      expect(reminder?.text).toContain("set to 50 minutes above 200k");
      expect(reminder?.createdBy).toBe("system");

      // The reminder's own turn is the session's work now.
      yield* clockAt(120);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("stays quiet when the last turn ended below the line", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:small");
      yield* service.set(threadId, setting);
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 150_000 });
      yield* clockAt(240);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(0);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("stays quiet while a turn runs or a message waits in a held queue", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const running = yield* seedThread("thread:running");
      const queued = yield* seedThread("thread:queued");
      for (const threadId of [running, queued]) {
        yield* service.set(threadId, setting);
        yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      }
      yield* turn(running, { ordinal: 2, endsAt: at(5), status: "running" });
      yield* turn(queued, { ordinal: 2, endsAt: at(5), status: "queued" });

      yield* clockAt(240);
      yield* sweep;
      expect(yield* reminders(running)).toHaveLength(0);
      expect(yield* reminders(queued)).toHaveLength(0);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("waits out a held background command, then counts the window from when it ended", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:building");
      yield* service.set(threadId, setting);
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          providerThread(threadId, at(1), [
            { kind: "command", taskId: "build", description: "vp build" },
          ]),
        ],
      });
      yield* dispatch((commandId) => ({
        type: "thread.background-work.hold",
        commandId,
        threadId,
        held: true,
      }));

      yield* clockAt(60);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(0);

      // The build ends without a new turn: the session is idle from here.
      yield* sink.write({ events: [providerThread(threadId, at(60.5))] });
      yield* clockAt(61);
      yield* sweep;
      yield* clockAt(109);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(0);

      yield* clockAt(111);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("comes again after the next idle stretch once the reminder's turn ends", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:rearm");
      yield* service.set(threadId, setting);
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      yield* clockAt(51);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(1);

      // The session did not hand off (something was in flight) and went idle.
      yield* finishReminderRun(threadId, at(55));
      yield* clockAt(104);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(1);
      yield* clockAt(106);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(2);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("never reminds a session that turned it off, or one that is settled", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const off = yield* seedThread("thread:off");
      const settled = yield* seedThread("thread:settled");
      for (const threadId of [off, settled]) {
        yield* service.set(threadId, setting);
        yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      }
      yield* clockAt(10);
      yield* sweep;
      yield* service.set(off, null);
      yield* dispatch((commandId) => ({ type: "thread.settle", commandId, threadId: settled }));

      yield* clockAt(240);
      yield* sweep;
      expect(yield* service.get(off)).toBeNull();
      expect(yield* reminders(off)).toHaveLength(0);
      expect(yield* reminders(settled)).toHaveLength(0);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect(
  "keeps the setting across a restart and reminds once for a window missed while down",
  () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:restarted");
      yield* lifetime((service) => service.set(threadId, setting));
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });

      // T3 was down from before the turn ended until well past the window.
      yield* clockAt(90);
      yield* lifetime((service, sweep) =>
        Effect.gen(function* () {
          expect(yield* service.get(threadId)).toEqual(setting);
          yield* sweep;
        }),
      );
      const [reminder, ...rest] = yield* reminders(threadId);
      expect(rest).toHaveLength(0);
      expect(reminder?.text).toContain("idle for 90 minutes");

      yield* clockAt(91);
      yield* lifetime((_service, sweep) => sweep);
      expect(yield* reminders(threadId)).toHaveLength(1);
    }).pipe(Effect.provide(base)),
);

it.effect("starts a fresh window when a settled session is reopened, even across a restart", () =>
  Effect.gen(function* () {
    const threadId = yield* seedThread("thread:reopened");
    yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
    yield* lifetime((service, sweep) =>
      Effect.gen(function* () {
        yield* service.set(threadId, setting);
        yield* dispatch((commandId) => ({ type: "thread.settle", commandId, threadId }));
        yield* clockAt(60);
        yield* sweep;
      }),
    );

    // Reopened at minute 120, after a restart, without a message.
    yield* clockAt(120);
    yield* dispatch((commandId) => ({
      type: "thread.unsettle",
      commandId,
      threadId,
      reason: "user",
    }));
    yield* lifetime((_service, sweep) =>
      Effect.gen(function* () {
        yield* clockAt(121);
        yield* sweep;
        expect(yield* reminders(threadId)).toHaveLength(0);
        yield* clockAt(171);
        yield* sweep;
        expect(yield* reminders(threadId)).toHaveLength(1);
      }),
    );
  }).pipe(Effect.provide(base)),
);

it.effect("starts a fresh window when an archived session is unarchived", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:unarchived");
      yield* service.set(threadId, setting);
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      yield* dispatch((commandId) => ({ type: "thread.archive", commandId, threadId }));
      yield* clockAt(119.6);
      yield* sweep;
      yield* clockAt(120);
      yield* dispatch((commandId) => ({ type: "thread.unarchive", commandId, threadId }));

      yield* clockAt(121);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(0);
      yield* clockAt(170);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(1);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("never reminds a session that has handed off to a successor", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:replaced");
      const successor = yield* seedThread("thread:successor");
      yield* service.set(threadId, setting);
      yield* turn(threadId, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      yield* dispatch((commandId) => ({
        type: "thread.metadata.update",
        commandId,
        threadId,
        successorThreadId: successor,
      }));
      yield* clockAt(240);
      yield* sweep;
      expect(yield* reminders(threadId)).toHaveLength(0);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("stays quiet while a question waits for the user, or after a failed turn", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const asking = yield* seedThread("thread:asking");
      const failed = yield* seedThread("thread:failed");
      for (const threadId of [asking, failed]) yield* service.set(threadId, setting);
      yield* turn(asking, { ordinal: 1, endsAt: at(0), usedTokens: 250_000 });
      yield* turn(failed, { ordinal: 1, endsAt: at(0), usedTokens: 250_000, status: "failed" });
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${asking}:question`),
            type: "runtime-request.updated",
            threadId: asking,
            occurredAt: at(0),
            payload: {
              id: RuntimeRequestId.make(`question:${asking}`),
              nodeId: NodeId.make(`question-node:${asking}`),
              providerTurnId: ProviderTurnId.make(`provider-turn:${asking}:1`),
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make(`session:${asking}`),
              },
              createdAt: at(0),
              resolvedAt: null,
            },
          },
        ],
      });
      const threads = yield* ThreadManagement.ThreadManagementService;
      expect((yield* threads.getThreadShell(asking))?.pendingRuntimeRequest).not.toBeNull();
      expect((yield* threads.getThreadShell(failed))?.status).toBe("failed");

      yield* clockAt(240);
      yield* sweep;
      expect(yield* reminders(asking)).toHaveLength(0);
      expect(yield* reminders(failed)).toHaveLength(0);
    }),
  ).pipe(Effect.provide(base)),
);

it.effect("keeps sweeping without failing when the settings table cannot be read", () =>
  lifetime((service, sweep) =>
    Effect.gen(function* () {
      const threadId = yield* seedThread("thread:broken-table");
      yield* service.set(threadId, setting);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE fork_session_idle_handoff`;
      // A failing sweep would die here, through the lifetime's orDie.
      yield* sweep;
      yield* sweep;
      expect(yield* Effect.flip(service.list)).toMatchObject({ _tag: "IdleHandoffStoreError" });
    }),
  ).pipe(Effect.provide(base)),
);
