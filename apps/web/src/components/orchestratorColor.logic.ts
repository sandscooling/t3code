import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarOrchestratorColor } from "@t3tools/contracts/settings";

/**
 * Fork: the swatches a project's orchestrator card can wear. The class names
 * are spelled out so Tailwind generates them; each maps to a theme token in
 * index.css. The tint is a background image, so it layers over the row's own
 * active and hover background color instead of replacing it.
 */
export const ORCHESTRATOR_COLORS: ReadonlyArray<{
  readonly id: SidebarOrchestratorColor;
  readonly label: string;
  readonly className: string;
}> = [
  {
    id: "red",
    label: "Red",
    className: "bg-linear-to-b from-orchestrator-red to-orchestrator-red",
  },
  {
    id: "orange",
    label: "Orange",
    className: "bg-linear-to-b from-orchestrator-orange to-orchestrator-orange",
  },
  {
    id: "amber",
    label: "Amber",
    className: "bg-linear-to-b from-orchestrator-amber to-orchestrator-amber",
  },
  {
    id: "green",
    label: "Green",
    className: "bg-linear-to-b from-orchestrator-green to-orchestrator-green",
  },
  {
    id: "teal",
    label: "Teal",
    className: "bg-linear-to-b from-orchestrator-teal to-orchestrator-teal",
  },
  {
    id: "blue",
    label: "Blue",
    className: "bg-linear-to-b from-orchestrator-blue to-orchestrator-blue",
  },
  {
    id: "violet",
    label: "Violet",
    className: "bg-linear-to-b from-orchestrator-violet to-orchestrator-violet",
  },
  {
    id: "pink",
    label: "Pink",
    className: "bg-linear-to-b from-orchestrator-pink to-orchestrator-pink",
  },
];

/**
 * Text on a tinted card: the row's secondary labels and icons read at full
 * strength, since their muted tones wash out against the tint. Status colors
 * keep their own meaning. The theme's foreground is near white in dark themes
 * and stays dark in light ones, where white would vanish on a pale tint.
 */
const ORCHESTRATOR_TEXT_CLASS_NAME =
  "text-sidebar-foreground [&_.text-secondary-label]:text-sidebar-foreground [&_.text-muted-foreground]:text-sidebar-foreground";

export function orchestratorColorClassName(color: SidebarOrchestratorColor): string {
  const tint = ORCHESTRATOR_COLORS.find((entry) => entry.id === color)?.className;
  return tint ? `${tint} ${ORCHESTRATOR_TEXT_CLASS_NAME}` : "";
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
