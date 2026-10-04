// Fork tests for ThreadForkService.test.ts.
import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadForkService from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
  };
}

function makeSourceRun(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeSourceProjection(
  sourceRun: OrchestrationV2Run,
  thread: OrchestrationV2AppThread,
): OrchestrationV2ThreadProjection {
  return {
    thread,
    runs: [sourceRun],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: snoozedAt,
  };
}

const planFork = (sourceRun: OrchestrationV2Run, sourceThread: OrchestrationV2AppThread) =>
  Effect.gen(function* () {
    const service = yield* ThreadForkService.ThreadForkServiceV2;
    return yield* service.plan({
      sourceProjection: makeSourceProjection(sourceRun, sourceThread),
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });
  }).pipe(Effect.provide(ThreadForkService.layer));

// Fork: the lane group follows the fork; the spawner and handoff successor do not.
it.effect("keeps the source's group but not its spawner or successor", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("completed"), {
      ...makeSourceThread(),
      group: "lane-a",
      spawnedByThreadId: ThreadId.make("thread:fork-spawner"),
      successorThreadId: ThreadId.make("thread:fork-successor"),
    });
    assert.equal(result.targetThread.group, "lane-a");
    assert.isNull(result.targetThread.spawnedByThreadId);
    assert.isNull(result.targetThread.successorThreadId);
  }),
);
