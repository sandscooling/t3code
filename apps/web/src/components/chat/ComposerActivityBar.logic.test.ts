import { describe, expect, it } from "vite-plus/test";

import {
  activityBadgeTabs,
  availableActivityTabs,
  type ComposerActivitySources,
  defaultActivityTab,
  resolveActivityTab,
} from "./ComposerActivityBar.logic";

const NONE = { present: false, liveCount: 0 } as const;
const SETTLED = { present: true, liveCount: 0 } as const;
const live = (liveCount: number) => ({ present: true, liveCount }) as const;

function sources(overrides: Partial<ComposerActivitySources>): ComposerActivitySources {
  return { tasks: NONE, agents: NONE, shells: NONE, ...overrides };
}

describe("availableActivityTabs", () => {
  it("keeps the fixed order regardless of which sources are present", () => {
    expect(availableActivityTabs(sources({ shells: live(1), tasks: SETTLED }))).toEqual([
      "tasks",
      "shells",
    ]);
  });

  it("is empty when nothing has anything to show", () => {
    expect(availableActivityTabs(sources({}))).toEqual([]);
  });
});

describe("defaultActivityTab", () => {
  it("leads with tasks when several sources are live", () => {
    expect(defaultActivityTab(sources({ tasks: live(2), agents: live(3), shells: live(1) }))).toBe(
      "tasks",
    );
  });

  it("hands the headline to a live source when the plan has settled", () => {
    expect(defaultActivityTab(sources({ tasks: SETTLED, agents: live(2) }))).toBe("agents");
  });

  it("falls back to priority order when nothing is live", () => {
    expect(defaultActivityTab(sources({ tasks: SETTLED, shells: SETTLED }))).toBe("tasks");
  });

  it("is null with no sources", () => {
    expect(defaultActivityTab(sources({}))).toBeNull();
  });
});

describe("resolveActivityTab", () => {
  it("honours a stored pick over the default", () => {
    expect(resolveActivityTab(sources({ tasks: live(1), shells: SETTLED }), "shells")).toBe(
      "shells",
    );
  });

  it("drops a stored pick whose source went away", () => {
    expect(resolveActivityTab(sources({ tasks: live(1) }), "shells")).toBe("tasks");
  });

  it("uses the default when nothing is stored", () => {
    expect(resolveActivityTab(sources({ agents: live(1) }), null)).toBe("agents");
  });
});

describe("activityBadgeTabs", () => {
  it("badges the live sources the headline is not already showing", () => {
    expect(
      activityBadgeTabs(sources({ tasks: live(1), agents: live(2), shells: live(1) }), "tasks"),
    ).toEqual(["agents", "shells"]);
  });

  it("does not badge settled sources", () => {
    expect(activityBadgeTabs(sources({ tasks: live(1), agents: SETTLED }), "tasks")).toEqual([]);
  });

  it("never badges the active tab", () => {
    expect(activityBadgeTabs(sources({ tasks: live(1), agents: live(1) }), "agents")).toEqual([
      "tasks",
    ]);
  });
});
