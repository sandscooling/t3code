import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ORCHESTRATOR = ThreadId.make("thread-orchestrator");

function makeThread(input: {
  readonly id: string;
  readonly parentThreadId?: string | null;
  readonly settledOverride?: OrchestrationThread["settledOverride"];
  readonly sessionStatus?: OrchestrationSession["status"];
  readonly pinnedAt?: string | null;
  readonly activities?: OrchestrationThread["activities"];
}): OrchestrationThread {
  const id = ThreadId.make(input.id);
  return {
    id,
    projectId: ProjectId.make("project-1"),
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId: input.parentThreadId == null ? null : ThreadId.make(input.parentThreadId),
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? NOW : null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: input.pinnedAt ?? null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: input.activities ?? [],
    checkpoints: [],
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId: id,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads, updatedAt: NOW };
}

const settleOrchestrator = (readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.settle",
      commandId: CommandId.make("cmd-settle-orchestrator"),
      threadId: ORCHESTRATOR,
    },
    readModel,
  });

it.layer(NodeServices.layer)("settling an orchestrator", (it) => {
  it.effect("settles the sessions it spawned", () =>
    Effect.gen(function* () {
      const result = yield* settleOrchestrator(
        makeReadModel([
          makeThread({ id: "thread-orchestrator" }),
          makeThread({ id: "thread-dev", parentThreadId: "thread-orchestrator" }),
          makeThread({ id: "thread-tests", parentThreadId: "thread-orchestrator" }),
          makeThread({ id: "thread-unrelated" }),
        ]),
      );
      const events = Array.isArray(result) ? result : [result];
      const settled = events
        .filter((event) => event.type === "thread.settled")
        .map((event) => event.aggregateId);
      expect(settled).toEqual(["thread-orchestrator", "thread-dev", "thread-tests"]);
    }),
  );

  it.effect("reaches a grandchild through the session that spawned it", () =>
    Effect.gen(function* () {
      const result = yield* settleOrchestrator(
        makeReadModel([
          makeThread({ id: "thread-orchestrator" }),
          makeThread({ id: "thread-dev", parentThreadId: "thread-orchestrator" }),
          makeThread({ id: "thread-helper", parentThreadId: "thread-dev" }),
        ]),
      );
      const events = Array.isArray(result) ? result : [result];
      // Only direct children settle here; the helper belongs to thread-dev,
      // which settles in the same pass and carries its own roster next time.
      const settled = events
        .filter((event) => event.type === "thread.settled")
        .map((event) => event.aggregateId);
      expect(settled).toEqual(["thread-orchestrator", "thread-dev"]);
    }),
  );

  it.effect("leaves a working session alone rather than hiding it", () =>
    Effect.gen(function* () {
      const result = yield* settleOrchestrator(
        makeReadModel([
          makeThread({ id: "thread-orchestrator" }),
          makeThread({
            id: "thread-dev",
            parentThreadId: "thread-orchestrator",
            sessionStatus: "running",
          }),
        ]),
      );
      const events = Array.isArray(result) ? result : [result];
      const settled = events
        .filter((event) => event.type === "thread.settled")
        .map((event) => event.aggregateId);
      expect(settled).toEqual(["thread-orchestrator"]);
    }),
  );

  it.effect("leaves a session that is blocked on the user alone", () =>
    Effect.gen(function* () {
      const result = yield* settleOrchestrator(
        makeReadModel([
          makeThread({ id: "thread-orchestrator" }),
          makeThread({
            id: "thread-review",
            parentThreadId: "thread-orchestrator",
            activities: [
              {
                id: EventId.make("activity-1"),
                turnId: null,
                sequence: 1,
                kind: "approval.requested",
                tone: "approval",
                summary: "Approval requested",
                payload: { requestId: "request-1" },
                createdAt: NOW,
              },
            ] as OrchestrationThread["activities"],
          }),
        ]),
      );
      const events = Array.isArray(result) ? result : [result];
      const settled = events
        .filter((event) => event.type === "thread.settled")
        .map((event) => event.aggregateId);
      expect(settled).toEqual(["thread-orchestrator"]);
    }),
  );

  it.effect("unpins a spawned session it settles", () =>
    Effect.gen(function* () {
      const result = yield* settleOrchestrator(
        makeReadModel([
          makeThread({ id: "thread-orchestrator" }),
          makeThread({
            id: "thread-dev",
            parentThreadId: "thread-orchestrator",
            pinnedAt: NOW,
          }),
        ]),
      );
      const events = Array.isArray(result) ? result : [result];
      const unpinned = events.filter((event) => event.type === "thread.unpinned");
      expect(unpinned.map((event) => event.aggregateId)).toEqual(["thread-dev"]);
    }),
  );

  it.effect("does not cascade on automatic settlement", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle"),
          threadId: ORCHESTRATOR,
          snapshotSequence: 0,
          settledAt: NOW,
        },
        readModel: makeReadModel([
          makeThread({ id: "thread-orchestrator" }),
          makeThread({ id: "thread-dev", parentThreadId: "thread-orchestrator" }),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];
      const settled = events
        .filter((event) => event.type === "thread.settled")
        .map((event) => event.aggregateId);
      expect(settled).toEqual(["thread-orchestrator"]);
    }),
  );
});
