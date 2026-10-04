import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarOrchestratorColor } from "@t3tools/contracts/settings";

/**
 * Fork: the swatches a project's orchestrator card can wear. The class names
 * are spelled out so Tailwind generates them: the 500 shade in light, the 400
 * in dark. `light-dark()` rather than a `dark:` variant keeps one class's
 * specificity, so a lifted row's `shadow-lg` still wins in both themes. The
 * color is a bar down the card's left edge, drawn as an inset shadow so it
 * follows the rounded corners and moves nothing.
 */
export const ORCHESTRATOR_COLORS: ReadonlyArray<{
  readonly id: SidebarOrchestratorColor;
  readonly label: string;
  readonly className: string;
}> = [
  {
    id: "red",
    label: "Red",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-red-500),var(--color-red-400))]",
  },
  {
    id: "orange",
    label: "Orange",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-orange-500),var(--color-orange-400))]",
  },
  {
    id: "amber",
    label: "Amber",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-amber-500),var(--color-amber-400))]",
  },
  {
    id: "green",
    label: "Green",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-green-500),var(--color-green-400))]",
  },
  {
    id: "teal",
    label: "Teal",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-teal-500),var(--color-teal-400))]",
  },
  {
    id: "blue",
    label: "Blue",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-blue-500),var(--color-blue-400))]",
  },
  {
    id: "violet",
    label: "Violet",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-violet-500),var(--color-violet-400))]",
  },
  {
    id: "pink",
    label: "Pink",
    className: "shadow-[inset_4px_0_0_light-dark(var(--color-pink-500),var(--color-pink-400))]",
  },
];

export function orchestratorColorClassName(color: SidebarOrchestratorColor): string {
  return ORCHESTRATOR_COLORS.find((entry) => entry.id === color)?.className ?? "";
}

export type OrchestratorColorMenuId =
  | "orchestrator-color"
  | "orchestrator-color:none"
  | `orchestrator-color:${SidebarOrchestratorColor}`;

/** The "Orchestrator color" submenu, with the project's current tint checked. */
export function buildOrchestratorColorMenuItem(
  current: SidebarOrchestratorColor | null,
): ContextMenuItem<OrchestratorColorMenuId> {
  return {
    id: "orchestrator-color",
    label: "Orchestrator color",
    children: [
      { id: "orchestrator-color:none", label: "None", checked: current === null },
      ...ORCHESTRATOR_COLORS.map((entry, index) => ({
        id: `orchestrator-color:${entry.id}` as const,
        label: entry.label,
        checked: current === entry.id,
        separatorBefore: index === 0,
      })),
    ],
  };
}

/**
 * The tint a clicked menu id picks: a color, `null` for None, or `undefined`
 * when the id is not one of this submenu's.
 */
export function parseOrchestratorColorMenuId(
  id: string | null | undefined,
): SidebarOrchestratorColor | null | undefined {
  if (id === "orchestrator-color:none") return null;
  return ORCHESTRATOR_COLORS.find((entry) => id === `orchestrator-color:${entry.id}`)?.id;
}

/**
 * Ids of the threads that are orchestrators: a top-level thread that has
 * spawned at least one session, or one titled exactly "Orchestrator". The
 * title covers an orchestrator whose spawned sessions were all pruned, and a
 * retired "Orchestrator-<date>" keeps no tint. A handoff successor takes over
 * the spawned sessions, so it inherits the tint with them before the rename.
 * A spawned thread is crew rather than top-level only when its spawner is in
 * the list and in the same project. One spawned from another project, or by a
 * spawner no longer listed, is top-level in its own project.
 */
export function orchestratorThreadIds(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly environmentId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly title?: string | undefined;
    readonly spawnedByThreadId?: string | null | undefined;
  }>,
): ReadonlySet<string> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const parents = new Set<string>();
  for (const thread of threads) {
    if (thread.spawnedByThreadId != null) parents.add(thread.spawnedByThreadId);
  }
  const orchestrators = new Set<string>();
  for (const thread of threads) {
    const spawner = thread.spawnedByThreadId != null ? byId.get(thread.spawnedByThreadId) : null;
    const isCrew =
      spawner != null &&
      spawner.environmentId === thread.environmentId &&
      spawner.projectId === thread.projectId;
    if (isCrew) continue;
    if (parents.has(thread.id) || thread.title === "Orchestrator") orchestrators.add(thread.id);
  }
  return orchestrators;
}

/** Writes one tint for every given project key; `null` clears it. */
export function withOrchestratorColor(
  colors: Readonly<Record<string, SidebarOrchestratorColor>>,
  projectKeys: ReadonlyArray<string>,
  color: SidebarOrchestratorColor | null,
): Record<string, SidebarOrchestratorColor> {
  const next = { ...colors };
  for (const key of projectKeys) {
    if (color === null) delete next[key];
    else next[key] = color;
  }
  return next;
}
