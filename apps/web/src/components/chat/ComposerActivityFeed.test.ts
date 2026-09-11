import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  composerActivityReservedRows,
  hasLiveComposerActivity,
  type ComposerActivityTasks,
} from "./ComposerActivityFeed";

function agents(overrides: Partial<AgentPanelModel> = {}): AgentPanelModel {
  return {
    workflows: [],
    directAgents: [],
    runningCount: 0,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 0,
    ...overrides,
  };
}

const tasks: ComposerActivityTasks = {
  progress: { step: "Wire the badge", completedSteps: 1, totalSteps: 3 },
  steps: [],
};

describe("hasLiveComposerActivity", () => {
  it("drops the strip once the last agent settles", () => {
    expect(hasLiveComposerActivity({ agents: agents({ settledCount: 3 }), tasks: null })).toBe(
      false,
    );
  });

  it("keeps the strip while an agent is still running", () => {
    expect(
      hasLiveComposerActivity({
        agents: agents({ runningCount: 1, liveCount: 1, settledCount: 2 }),
        tasks: null,
      }),
    ).toBe(true);
  });

  it("keeps the strip for an idle agent, which has not settled", () => {
    expect(hasLiveComposerActivity({ agents: agents({ idleCount: 1 }), tasks: null })).toBe(true);
  });

  it("keeps a live task list even when every agent has settled", () => {
    expect(hasLiveComposerActivity({ agents: agents({ settledCount: 2 }), tasks })).toBe(true);
  });

  it("hides the strip when neither feed exists", () => {
    expect(hasLiveComposerActivity({ agents: null, tasks: null })).toBe(false);
  });
});

function subagent(id: string): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: id,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

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
      composerActivityReservedRows({
        agents: agents({ directAgents: [subagent("a")], runningCount: 1, liveCount: 1 }),
        tasks: taskSteps(6),
      }),
    ).toBe(6);
  });

  it("reserves the agent roster when it is the taller feed", () => {
    expect(
      composerActivityReservedRows({
        agents: agents({
          directAgents: [subagent("a"), subagent("b"), subagent("c")],
          runningCount: 3,
          liveCount: 3,
        }),
        tasks: taskSteps(1),
      }),
    ).toBe(3);
  });

  it("reserves nothing for a lone feed, which has no other tab to match", () => {
    expect(
      composerActivityReservedRows({
        agents: agents({ directAgents: [subagent("a")], runningCount: 1, liveCount: 1 }),
        tasks: null,
      }),
    ).toBe(0);
    expect(composerActivityReservedRows({ agents: null, tasks: taskSteps(4) })).toBe(0);
  });
});
