/**
 * Which source the composer activity bar shows, and when it offers tabs.
 *
 * The bar is one strip over three unrelated feeds — the plan, the subagent
 * roster, and this thread's shells. Deciding *what* it shows is pure and
 * lives here; the component only draws.
 */

export type ComposerActivityTab = "tasks" | "agents" | "shells";

/** Priority order, and the order tabs render in. Tasks win ties by design. */
export const ACTIVITY_TAB_ORDER = ["tasks", "agents", "shells"] as const;

export interface ComposerActivitySource {
  /** There is anything at all to show — a settled plan still counts. */
  readonly present: boolean;
  /** Something is happening right now: an unfinished step, a working agent,
   *  a shell running a subprocess. Drives both the default tab and badges. */
  readonly liveCount: number;
}

export type ComposerActivitySources = Readonly<Record<ComposerActivityTab, ComposerActivitySource>>;

export function availableActivityTabs(
  sources: ComposerActivitySources,
): ReadonlyArray<ComposerActivityTab> {
  return ACTIVITY_TAB_ORDER.filter((tab) => sources[tab].present);
}

/**
 * The source the bar leads with. A live source always beats a settled one, so
 * a finished plan hands the headline to the agents that are still working;
 * within each group the fixed priority order decides.
 */
export function defaultActivityTab(sources: ComposerActivitySources): ComposerActivityTab | null {
  const available = availableActivityTabs(sources);
  return available.find((tab) => sources[tab].liveCount > 0) ?? available[0] ?? null;
}

/**
 * The stored pick, honoured only while it still has something to show —
 * otherwise the bar would sit on an empty tab after its shells closed.
 */
export function resolveActivityTab(
  sources: ComposerActivitySources,
  stored: ComposerActivityTab | null | undefined,
): ComposerActivityTab | null {
  if (stored && sources[stored].present) {
    return stored;
  }
  return defaultActivityTab(sources);
}

/** Live sources the headline is not already speaking for, as count chips. */
export function activityBadgeTabs(
  sources: ComposerActivitySources,
  activeTab: ComposerActivityTab | null,
): ReadonlyArray<ComposerActivityTab> {
  return ACTIVITY_TAB_ORDER.filter(
    (tab) => tab !== activeTab && sources[tab].present && sources[tab].liveCount > 0,
  );
}
