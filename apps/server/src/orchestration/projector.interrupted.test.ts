import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly occurredAt: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function makeSession(input: {
  readonly status: string;
  readonly activeTurnId: string | null;
  readonly updatedAt: string;
}) {
  return {
    threadId: ThreadId.make("thread-1"),
    status: input.status,
    providerName: "codex",
    providerSessionId: "session-1",
    providerThreadId: "provider-thread-1",
    runtimeMode: "approval-required",
    activeTurnId: input.activeTurnId,
    lastError: null,
    updatedAt: input.updatedAt,
  };
}

const CREATED_AT = "2026-02-23T09:00:00.000Z";
const STARTED_AT = "2026-02-23T09:00:01.000Z";
const STOPPED_AT = "2026-02-23T09:00:05.000Z";
// CheckpointReactor captures the real git ref a couple of seconds after the
// turn ends, which is exactly how long the transcript notice used to survive.
const CAPTURED_AT = "2026-02-23T09:00:07.000Z";

const seedStoppedTurn = Effect.gen(function* () {
  const created = yield* projectEvent(
    createEmptyReadModel(CREATED_AT),
    makeEvent({
      sequence: 1,
      type: "thread.created",
      occurredAt: CREATED_AT,
      payload: {
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    }),
  );

  const running = yield* projectEvent(
    created,
    makeEvent({
      sequence: 2,
      type: "thread.session-set",
      occurredAt: STARTED_AT,
      payload: {
        threadId: ThreadId.make("thread-1"),
        session: makeSession({ status: "running", activeTurnId: "turn-1", updatedAt: STARTED_AT }),
      },
    }),
  );

  // The user presses Stop.
  return yield* projectEvent(
    running,
    makeEvent({
      sequence: 3,
      type: "thread.session-set",
      occurredAt: STOPPED_AT,
      payload: {
        threadId: ThreadId.make("thread-1"),
        session: makeSession({ status: "stopped", activeTurnId: null, updatedAt: STOPPED_AT }),
      },
    }),
  );
});

function checkpointCaptured(status: "ready" | "missing" | "error") {
  return makeEvent({
    sequence: 4,
    type: "thread.turn-diff-completed",
    occurredAt: CAPTURED_AT,
    payload: {
      threadId: ThreadId.make("thread-1"),
      turnId: "turn-1",
      checkpointTurnCount: 1,
      checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
      status,
      files: [],
      assistantMessageId: null,
      completedAt: CAPTURED_AT,
    },
  });
}

it.effect("settles a stopped turn as interrupted", () =>
  Effect.gen(function* () {
    const stopped = yield* seedStoppedTurn;
    expect(stopped.threads[0]?.latestTurn?.state).toBe("interrupted");
  }),
);

it.effect("keeps an interrupted turn interrupted once its checkpoint is captured", () =>
  Effect.gen(function* () {
    const stopped = yield* seedStoppedTurn;
    const captured = yield* projectEvent(stopped, checkpointCaptured("ready"));

    // A captured checkpoint says a git ref exists, not that the turn ran to
    // completion. Mapping "ready" to "completed" here erased the only record
    // that the user had stopped this turn, so the transcript's "Stopped, ready
    // for your next message" notice appeared and then vanished mid-read.
    expect(captured.threads[0]?.latestTurn?.state).toBe("interrupted");
    expect(captured.threads[0]?.checkpoints).toHaveLength(1);
    expect(captured.threads[0]?.checkpoints[0]?.status).toBe("ready");
  }),
);

it.effect("still derives turn state from the checkpoint for an unseen turn", () =>
  Effect.gen(function* () {
    const stopped = yield* seedStoppedTurn;
    const otherTurn = yield* projectEvent(
      stopped,
      makeEvent({
        sequence: 5,
        type: "thread.turn-diff-completed",
        occurredAt: CAPTURED_AT,
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: CAPTURED_AT,
        },
      }),
    );

    // The preserve-what-is-settled rule is scoped to the turn it belongs to: a
    // checkpoint for a different turn still gets its state from the status.
    expect(otherTurn.threads[0]?.latestTurn?.turnId).toBe("turn-2");
    expect(otherTurn.threads[0]?.latestTurn?.state).toBe("completed");
  }),
);
