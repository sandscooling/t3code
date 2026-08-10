import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectReapableThreadKeys } from "./settledPreviewReaper.logic";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T00:00:00.000Z";
const AUTO_SETTLE_DAYS = 3;

function makeShell(input: {
  readonly id: string;
  readonly activityAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly sessionStatus?: "starting" | "running";
  readonly pending?: "approval";
}): OrchestrationThreadShell {
  const threadId = ThreadId.make(input.id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.activityAt === null
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === "settled" ? NOW : null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function shellMap(...shells: ReadonlyArray<OrchestrationThreadShell>) {
  return new Map(shells.map((shell) => [shell.id as string, shell]));
}

function reap(input: {
  readonly previewThreadKeys: ReadonlyArray<string>;
  readonly shells: ReadonlyArray<OrchestrationThreadShell>;
  readonly onScreen?: ReadonlyArray<string>;
}) {
  return selectReapableThreadKeys({
    previewThreadKeys: input.previewThreadKeys,
    shellByThreadKey: shellMap(...input.shells),
    onScreenThreadKeys: new Set(input.onScreen ?? []),
    now: NOW,
    autoSettleAfterDays: AUTO_SETTLE_DAYS,
  });
}

describe("selectReapableThreadKeys", () => {
  it("reaps a thread that aged past the auto-settle window", () => {
    const shell = makeShell({ id: "old", activityAt: STALE });
    expect(reap({ previewThreadKeys: ["old"], shells: [shell] })).toEqual(["old"]);
  });

  it("reaps an explicitly settled thread even when it is fresh", () => {
    const shell = makeShell({ id: "settled", activityAt: FRESH, settledOverride: "settled" });
    expect(reap({ previewThreadKeys: ["settled"], shells: [shell] })).toEqual(["settled"]);
  });

  it("leaves a recently active thread alone", () => {
    const shell = makeShell({ id: "fresh", activityAt: FRESH });
    expect(reap({ previewThreadKeys: ["fresh"], shells: [shell] })).toEqual([]);
  });

  it("never reaps the thread on screen, even once it settles", () => {
    const shell = makeShell({ id: "open", activityAt: STALE });
    expect(reap({ previewThreadKeys: ["open"], shells: [shell], onScreen: ["open"] })).toEqual([]);
  });

  it("leaves a running session alone however old its last turn is", () => {
    const shell = makeShell({ id: "busy", activityAt: STALE, sessionStatus: "running" });
    expect(reap({ previewThreadKeys: ["busy"], shells: [shell] })).toEqual([]);
  });

  it("leaves a thread blocked on an approval alone", () => {
    const shell = makeShell({ id: "blocked", activityAt: STALE, pending: "approval" });
    expect(reap({ previewThreadKeys: ["blocked"], shells: [shell] })).toEqual([]);
  });

  it("leaves a keep-active pin alone", () => {
    const shell = makeShell({ id: "pinned", activityAt: STALE, settledOverride: "active" });
    expect(reap({ previewThreadKeys: ["pinned"], shells: [shell] })).toEqual([]);
  });

  it("treats a thread with no loaded shell as unknown rather than idle", () => {
    expect(reap({ previewThreadKeys: ["ghost"], shells: [] })).toEqual([]);
  });

  it("reaps only the settled subset when several threads hold tabs", () => {
    const stale = makeShell({ id: "stale", activityAt: STALE });
    const fresh = makeShell({ id: "fresh", activityAt: FRESH });
    const viewed = makeShell({ id: "viewed", activityAt: STALE });
    expect(
      reap({
        previewThreadKeys: ["stale", "fresh", "viewed"],
        shells: [stale, fresh, viewed],
        onScreen: ["viewed"],
      }),
    ).toEqual(["stale"]);
  });

  it("does not reap when auto-settle is disabled and nothing is explicitly settled", () => {
    const shell = makeShell({ id: "old", activityAt: STALE });
    expect(
      selectReapableThreadKeys({
        previewThreadKeys: ["old"],
        shellByThreadKey: shellMap(shell),
        onScreenThreadKeys: new Set(),
        now: NOW,
        autoSettleAfterDays: null,
      }),
    ).toEqual([]);
  });
});
