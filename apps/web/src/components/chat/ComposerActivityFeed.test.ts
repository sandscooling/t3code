import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { hasLiveComposerActivity, type ComposerActivityTasks } from "./ComposerActivityFeed";

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
