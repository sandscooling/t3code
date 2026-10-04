// Fork-owned tests for MessagesTimeline.logic.test.ts.
import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

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
