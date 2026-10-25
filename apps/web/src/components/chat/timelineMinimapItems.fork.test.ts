import { MessageId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems } from "./timelineMinimapItems";

function messageRow(id: string, message: Partial<ChatMessage>): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-25T00:00:00.000Z",
    durationStart: "2026-10-25T00:00:00.000Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    message: {
      id: MessageId.make(id),
      role: "user",
      text: id,
      runId: null,
      streaming: false,
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      ...message,
    },
  } as MessagesTimelineRow;
}

describe("deriveTimelineMinimapItems", () => {
  it("ticks only messages the user typed", () => {
    const rows = [
      messageRow("typed", { createdBy: "user", creationSource: "web" }),
      messageRow("answer", { role: "assistant", text: "reply" }),
      messageRow("legacy", {}),
      messageRow("wake", {
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: ThreadId.make("mcp:session:worker"),
      }),
      messageRow("notice", { createdBy: "system", creationSource: "server" }),
      messageRow("scheduled", {
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: ScheduledTaskId.make("scheduled-task:sync"),
      }),
      messageRow("relayed", { createdBy: "user", senderThreadId: ThreadId.make("thread:other") }),
    ];

    const items = deriveTimelineMinimapItems(rows);

    expect(items.map((item) => item.id)).toEqual(["typed", "legacy"]);
    expect(items[0]?.assistantText).toBe("reply");
  });
});
