import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarOrchestratorColor } from "@t3tools/contracts/settings";

/**
 * Fork: the swatches a project's orchestrator card can wear. The class names
 * are spelled out so Tailwind generates them; each maps to a theme token in
 * index.css. The color is a bar down the card's left edge, drawn as an inset
 * shadow so it follows the rounded corners and moves nothing.
 */
export const ORCHESTRATOR_COLORS: ReadonlyArray<{
  readonly id: SidebarOrchestratorColor;
  readonly label: string;
  readonly className: string;
}> = [
  {
    id: "red",
    label: "Red",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-red)]",
  },
  {
    id: "orange",
    label: "Orange",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-orange)]",
  },
  {
    id: "amber",
    label: "Amber",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-amber)]",
  },
  {
    id: "green",
    label: "Green",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-green)]",
  },
  {
    id: "teal",
    label: "Teal",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-teal)]",
  },
  {
    id: "blue",
    label: "Blue",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-blue)]",
  },
  {
    id: "violet",
    label: "Violet",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-violet)]",
  },
  {
    id: "pink",
    label: "Pink",
    className: "shadow-[inset_4px_0_0_var(--color-orchestrator-pink)]",
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
 * spawned at least one session. A handoff successor takes over the spawned
 * sessions, so it inherits the tint with them.
 */
export function orchestratorThreadIds(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly parentThreadId?: string | null | undefined;
  }>,
): ReadonlySet<string> {
  const parents = new Set<string>();
  for (const thread of threads) {
    if (thread.parentThreadId != null) parents.add(thread.parentThreadId);
  }
  const orchestrators = new Set<string>();
  for (const thread of threads) {
    if (thread.parentThreadId == null && parents.has(thread.id)) orchestrators.add(thread.id);
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
