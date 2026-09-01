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

function makeShell(input: {
  readonly id: string;
  readonly activityAt: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly sessionStatus?: "starting" | "running";
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
    hasPendingApprovals: false,
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
  });
}

describe("selectReapableThreadKeys", () => {
  it("reaps a thread the server has stamped settled", () => {
    const shell = makeShell({ id: "settled", activityAt: FRESH, settledOverride: "settled" });
    expect(reap({ previewThreadKeys: ["settled"], shells: [shell] })).toEqual(["settled"]);
  });

  it("leaves an unsettled thread alone", () => {
    const shell = makeShell({ id: "fresh", activityAt: FRESH });
    expect(reap({ previewThreadKeys: ["fresh"], shells: [shell] })).toEqual([]);
  });

  it("never reaps the thread on screen, even once it settles", () => {
    const shell = makeShell({ id: "open", activityAt: FRESH, settledOverride: "settled" });
    expect(reap({ previewThreadKeys: ["open"], shells: [shell], onScreen: ["open"] })).toEqual([]);
  });

  it("leaves a keep-active pin alone", () => {
    const shell = makeShell({ id: "pinned", activityAt: FRESH, settledOverride: "active" });
    expect(reap({ previewThreadKeys: ["pinned"], shells: [shell] })).toEqual([]);
  });

  it("treats a thread with no loaded shell as unknown rather than idle", () => {
    expect(reap({ previewThreadKeys: ["ghost"], shells: [] })).toEqual([]);
  });

  it("reaps only the settled subset when several threads hold tabs", () => {
    const settled = makeShell({ id: "settled", activityAt: FRESH, settledOverride: "settled" });
    const fresh = makeShell({ id: "fresh", activityAt: FRESH });
    const viewed = makeShell({ id: "viewed", activityAt: FRESH, settledOverride: "settled" });
    expect(
      reap({
        previewThreadKeys: ["settled", "fresh", "viewed"],
        shells: [settled, fresh, viewed],
        onScreen: ["viewed"],
      }),
    ).toEqual(["settled"]);
  });
});
