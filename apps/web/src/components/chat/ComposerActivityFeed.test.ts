import { deriveThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  composerActivityReservedRows,
  hasLiveComposerActivity,
  type ComposerActivityTasks,
} from "./ComposerActivityFeed";
import { composerAgentLead, composerAgentRows } from "./ComposerAgentsBadge";

function subagent(
  id: string,
  status: OrchestrationV2Subagent["status"],
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-1"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: `Task ${id}`,
    title: id,
    model: null,
    status,
    result: null,
    startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

// The roster the composer receives: v2's own derivation over one live run.
function turn(...subagents: OrchestrationV2Subagent[]) {
  const runs = [{ id: RunId.make("run-1"), status: "running" }] as never;
  return deriveThreadTurnSubagents({ runs, subagents });
}

const tasks: ComposerActivityTasks = {
  progress: { step: "Wire the badge", completedSteps: 1, totalSteps: 3 },
  steps: [],
};

describe("hasLiveComposerActivity", () => {
  it("drops the strip once the last agent settles", () => {
    const agents = turn(
      subagent("a", "completed"),
      subagent("b", "failed"),
      subagent("c", "cancelled"),
    );
    expect(hasLiveComposerActivity({ agents, tasks: null })).toBe(false);
  });

  it("keeps the strip while an agent is still running", () => {
    const agents = turn(subagent("a", "running"), subagent("b", "completed"));
    expect(hasLiveComposerActivity({ agents, tasks: null })).toBe(true);
  });

  it("keeps the strip for an idle agent, which has not settled", () => {
    expect(hasLiveComposerActivity({ agents: turn(subagent("a", "idle")), tasks: null })).toBe(
      true,
    );
  });

  it("keeps a live task list even when every agent has settled", () => {
    expect(hasLiveComposerActivity({ agents: turn(subagent("a", "completed")), tasks })).toBe(true);
  });

  it("hides the strip when neither feed exists", () => {
    expect(hasLiveComposerActivity({ agents: null, tasks: null })).toBe(false);
  });
});

function taskSteps(count: number): ComposerActivityTasks {
  return {
    progress: { step: "Wire the badge", completedSteps: 0, totalSteps: count },
    steps: Array.from({ length: count }, (_, index) => ({
      step: `Step ${index}`,
      status: "pending" as const,
    })),
  };
}

describe("composerActivityReservedRows", () => {
  it("reserves the taller feed so switching tabs holds the height", () => {
    expect(
      composerActivityReservedRows({ agents: turn(subagent("a", "running")), tasks: taskSteps(6) }),
    ).toBe(6);
  });

  it("reserves the agent roster when it is the taller feed", () => {
    expect(
      composerActivityReservedRows({
        agents: turn(subagent("a", "running"), subagent("b", "running"), subagent("c", "running")),
        tasks: taskSteps(1),
      }),
    ).toBe(3);
  });

  it("reserves nothing for a lone feed, which has no other tab to match", () => {
    expect(
      composerActivityReservedRows({ agents: turn(subagent("a", "running")), tasks: null }),
    ).toBe(0);
    expect(composerActivityReservedRows({ agents: null, tasks: taskSteps(4) })).toBe(0);
  });
});

describe("composer agent rows", () => {
  it("names the first unsettled agent on the summary line", () => {
    const agents = turn(
      subagent("done", "completed", { startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") }),
      subagent("busy", "running", { startedAt: DateTime.makeUnsafe("2026-01-01T00:00:05Z") }),
    );
    expect(agents && composerAgentLead(agents)?.title).toBe("busy");
  });

  it("links only the rows that have a thread of their own", () => {
    const agents = turn(
      subagent("native", "running"),
      subagent("delegated", "running", {
        childThreadId: ThreadId.make("thread-child"),
        startedAt: DateTime.makeUnsafe("2026-01-01T00:00:05Z"),
      }),
    );
    expect(agents && composerAgentRows(agents).map((row) => row.childThreadId)).toEqual([
      null,
      ThreadId.make("thread-child"),
    ]);
  });
});
