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
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const now = "2026-01-01T00:00:00.000Z";

const createdPayload = (group?: string | null) => ({
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "T-1234-dev",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  ...(group !== undefined ? { group } : {}),
  createdAt: now,
  updatedAt: now,
});

it.effect("projects the group from thread.created", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "thread.created", payload: createdPayload("T-1234") }),
    );
    expect(created.threads[0]?.group).toBe("T-1234");
  }),
);

it.effect("projects an old thread.created without a group as null", () =>
  Effect.gen(function* () {
    // Events written before the field existed carry no key at all.
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "thread.created", payload: createdPayload() }),
    );
    expect(created.threads[0]?.group).toBeNull();
  }),
);

it.effect("projects group changes from thread.meta-updated and leaves it alone otherwise", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "thread.created", payload: createdPayload("T-1234") }),
    );
    const renamed = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.meta-updated",
        payload: { threadId: ThreadId.make("thread-1"), title: "Renamed", updatedAt: now },
      }),
    );
    expect(renamed.threads[0]?.group).toBe("T-1234");

    const cleared = yield* projectEvent(
      renamed,
      makeEvent({
        sequence: 3,
        type: "thread.meta-updated",
        payload: { threadId: ThreadId.make("thread-1"), group: null, updatedAt: now },
      }),
    );
    expect(cleared.threads[0]?.group).toBeNull();
  }),
);
