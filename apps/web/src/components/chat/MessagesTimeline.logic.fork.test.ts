// Fork-owned tests for MessagesTimeline.logic.test.ts.
import { MessageId, RunId, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import { deriveMessagesTimelineRows, type TimelineLatestRun } from "./MessagesTimeline.logic";
import {
  citedCollapsedLatestRunId,
  latestCompletedRunId,
  toggledCollapsedLatestRunId,
} from "./MessagesTimeline.logic.fork";

// Fork: images and answered questions are content to look at, so the fold never
// swallows them. Every test in this block is fork-owned.
describe("pinned work rows (fork)", () => {
  const createdAt = "2026-09-01T12:00:00Z";
  const command = (id: string): WorkLogEntry => ({
    id,
    createdAt,
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    command: "ls",
  });
  const image = (id: string, toolName: string): WorkLogEntry => ({
    id,
    createdAt,
    label: "Image",
    tone: "tool",
    itemType: "dynamic_tool",
    viewedImagePath: "/home/user/.codex/generated_images/fan.png",
    structuredPayload: { type: "dynamic_tool", toolName } as never,
  });
  // A lone row lists its entry ids; a folded group shows only its count.
  const groupedIds = (entries: ReadonlyArray<WorkLogEntry>) =>
    deriveMessagesTimelineRows({
      timelineEntries: entries.map((entry) => ({
        id: `entry-${entry.id}`,
        kind: "work" as const,
        createdAt,
        entry,
      })),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    }).flatMap((row): Array<string | ReadonlyArray<string>> =>
      row.kind === "work"
        ? [row.groupedEntries.map((entry) => entry.id)]
        : row.kind === "work-toggle"
          ? [`folded:${row.hiddenCount}`]
          : [],
    );

  it("keeps a generated image as its own row between grouped tool calls", () => {
    expect(
      groupedIds([command("a"), command("b"), image("img", "image_generation"), command("c")]),
    ).toEqual(["folded:2", ["img"], ["c"]]);
  });

  // Fork: an image the agent viewed pins too, as v1 did.
  it("keeps an image the agent viewed as its own row, as v1 did", () => {
    expect(groupedIds([command("a"), command("b"), image("img", "Read"), command("c")])).toEqual([
      "folded:2",
      ["img"],
      ["c"],
    ]);
  });

  // Fork: a Read of an image path pins without a viewedImagePath.
  it("keeps a Read of an image file without a viewed path as its own row", () => {
    const read: WorkLogEntry = {
      id: "read",
      createdAt,
      label: "Read fan.png",
      tone: "tool",
      requestKind: "file-read",
      detail: "assets/fan.png",
    };
    expect(groupedIds([command("a"), command("b"), read, command("c")])).toEqual([
      "folded:2",
      ["read"],
      ["c"],
    ]);
  });

  // Fork: a submitted answer stays out of the fold (fork commit c9aa31f1a7).
  it("keeps a submitted answer out of the fold when later work follows it", () => {
    const answer: WorkLogEntry = {
      id: "answer",
      createdAt,
      label: "Answered questions",
      tone: "info",
      itemType: "user_input_request",
      questionAnswer: {
        requestId: RuntimeRequestId.make("question-request"),
        answers: { scope: "Fold the two fixes in" },
        attachmentsByQuestionId: {},
      },
    };
    expect(groupedIds([command("a"), answer, command("b"), command("c")])).toEqual([
      ["a"],
      ["answer"],
      "folded:2",
    ]);
  });

  // Fork: the pin leaves ordinary tool calls folded.
  it("still folds plain tool calls", () => {
    expect(groupedIds([command("a"), command("b"), command("c")])).toEqual(["folded:3"]);
  });
});

// Fork: the latest completed turn shows its work; older turns fold.
describe("latest turn fold opens (fork)", () => {
  const at = (second: number) => `2026-10-04T12:00:${String(second).padStart(2, "0")}Z`;
  // One turn: a prompt, a tool call, and the final answer, ten seconds apart per turn.
  const turn = (index: number): TimelineEntry[] => {
    const runId = RunId.make(`turn-${index}`);
    const start = index * 10;
    return [
      {
        id: `user-${index}`,
        kind: "message",
        createdAt: at(start),
        message: {
          id: MessageId.make(`user-${index}`),
          role: "user",
          text: "Go",
          runId,
          createdAt: at(start),
          updatedAt: at(start),
          streaming: false,
        },
      },
      {
        id: `work-${index}`,
        kind: "work",
        createdAt: at(start + 1),
        entry: {
          id: `work-${index}`,
          createdAt: at(start + 1),
          runId,
          label: "Ran command",
          tone: "tool",
        },
      },
      {
        id: `final-${index}`,
        kind: "message",
        createdAt: at(start + 2),
        message: {
          id: MessageId.make(`final-${index}`),
          role: "assistant",
          text: "Done",
          runId,
          createdAt: at(start + 2),
          updatedAt: at(start + 2),
          streaming: false,
        },
      },
    ];
  };
  const latest = (index: number, status: TimelineLatestRun["status"]): TimelineLatestRun => ({
    runId: RunId.make(`turn-${index}`),
    status,
    startedAt: at(index * 10),
    completedAt: status === "running" ? null : at(index * 10 + 2),
  });
  // Each turn's fold state, and whether its tool call is on screen.
  const folds = (input: {
    turns: number;
    latestRun: TimelineLatestRun;
    expandedRunIds?: ReadonlySet<RunId>;
    collapsedLatestRunId?: RunId | null;
    isWorking?: boolean;
  }) => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: Array.from({ length: input.turns }, (_, index) => turn(index + 1)).flat(),
      latestRun: input.latestRun,
      expandedRunIds: input.expandedRunIds ?? new Set(),
      openLatestTurnFold: true,
      collapsedLatestRunId: input.collapsedLatestRunId ?? null,
      isWorking: input.isWorking ?? false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const workVisible = (index: number) =>
      rows.some(
        (row) =>
          row.kind === "work" && row.groupedEntries.some((entry) => entry.id === `work-${index}`),
      );
    return Array.from({ length: input.turns }, (_, index) => {
      const fold = rows.find((row) => row.id === `turn-fold:turn-${index + 1}`);
      const state = fold?.kind === "turn-fold" ? (fold.expanded ? "open" : "folded") : "none";
      return `${state}${workVisible(index + 1) ? "+work" : ""}`;
    });
  };

  it("opens the latest completed turn and folds the older ones", () => {
    expect(folds({ turns: 2, latestRun: latest(2, "completed") })).toEqual(["folded", "open+work"]);
  });

  it("keeps the latest turn collapsed once the user collapses it", () => {
    expect(
      folds({
        turns: 2,
        latestRun: latest(2, "completed"),
        collapsedLatestRunId: RunId.make("turn-2"),
      }),
    ).toEqual(["folded", "folded"]);
  });

  it("folds the previous turn once a newer one completes, unless the user opened it", () => {
    expect(folds({ turns: 3, latestRun: latest(3, "completed") })).toEqual([
      "folded",
      "folded",
      "open+work",
    ]);
    expect(
      folds({
        turns: 3,
        latestRun: latest(3, "completed"),
        expandedRunIds: new Set([RunId.make("turn-1")]),
      }),
    ).toEqual(["open+work", "folded", "open+work"]);
  });

  // The user collapsed turn 1 and left the thread; turn 2 ran meanwhile, so
  // nothing cleaned up the stale collapse.
  it("keeps a collapsed turn folded after a newer turn arrives while away", () => {
    expect(
      folds({
        turns: 2,
        latestRun: latest(2, "completed"),
        collapsedLatestRunId: RunId.make("turn-1"),
      }),
    ).toEqual(["folded", "open+work"]);
    expect(
      folds({
        turns: 2,
        latestRun: latest(2, "running"),
        collapsedLatestRunId: RunId.make("turn-1"),
        isWorking: true,
      }),
    ).toEqual(["folded", "none+work"]);
  });

  it("leaves an in-progress turn unfolded and the previous turn folded", () => {
    expect(folds({ turns: 2, latestRun: latest(2, "running"), isWorking: true })).toEqual([
      "folded",
      "none+work",
    ]);
  });

  it("keeps an interrupted latest turn on upstream's handling", () => {
    expect(folds({ turns: 2, latestRun: latest(2, "interrupted") })).toEqual(["folded", "folded"]);
    expect(
      folds({
        turns: 2,
        latestRun: latest(2, "interrupted"),
        expandedRunIds: new Set([RunId.make("turn-2")]),
      }),
    ).toEqual(["folded", "open+work"]);
  });

  it("routes a click on the latest completed turn to the fork's collapse", () => {
    const latestCompleted = latestCompletedRunId(latest(2, "completed"));
    const turn2 = RunId.make("turn-2");
    expect(toggledCollapsedLatestRunId(null, latestCompleted, turn2)).toBe(turn2);
    expect(toggledCollapsedLatestRunId(turn2, latestCompleted, turn2)).toBeNull();
    // An older or interrupted turn stays on upstream's expandedRunIds toggle.
    expect(
      toggledCollapsedLatestRunId(null, latestCompleted, RunId.make("turn-1")),
    ).toBeUndefined();
    expect(
      toggledCollapsedLatestRunId(null, latestCompletedRunId(latest(2, "interrupted")), turn2),
    ).toBeUndefined();
  });

  // A citation into the latest turn must not add it to expandedRunIds: a later
  // collapse would otherwise come back open once a newer run arrives.
  it("opens a cited latest turn without adding it to upstream's opened set", () => {
    const latestCompleted = latestCompletedRunId(latest(2, "completed"));
    const turn2 = RunId.make("turn-2");
    expect(citedCollapsedLatestRunId(turn2, latestCompleted, turn2)).toBeNull();
    expect(citedCollapsedLatestRunId(null, latestCompleted, turn2)).toBeNull();
    // An older turn is upstream's to add.
    expect(citedCollapsedLatestRunId(null, latestCompleted, RunId.make("turn-1"))).toBeUndefined();
    // Cite turn 1 while latest, collapse it, then turn 2 completes: still folded.
    expect(
      folds({
        turns: 2,
        latestRun: latest(2, "completed"),
        collapsedLatestRunId: RunId.make("turn-1"),
        expandedRunIds: new Set(),
      }),
    ).toEqual(["folded", "open+work"]);
  });
});
