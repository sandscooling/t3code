// Fork: the tint an orchestrator's sidebar card wears, set per project from the
// thread menu or a project group header's menu. Sidebar.tsx keeps the call sites.
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarOrchestratorColor } from "@t3tools/contracts/settings";

import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  buildOrchestratorColorMenuItem,
  orchestratorColorClassName,
  orchestratorThreadIds,
  parseOrchestratorColorMenuId,
  withOrchestratorColor,
} from "./orchestratorColor.logic";

type ColorThread = {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly settledOverride?: "settled" | "active" | null | undefined;
};
/** Sidebar's projects keyed by `${environmentId}:${projectId}`. */
type ProjectByKey = ReadonlyMap<string, Parameters<typeof derivePhysicalProjectKey>[0]>;

const projectOf = (thread: ColorThread, projectByKey: ProjectByKey) =>
  projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null;

export interface OrchestratorColorMenu<Input> {
  /** What the menu builder takes; null leaves the submenu out. */
  readonly input: Input;
  /** Applies a click on this submenu and returns true; false for any other item. */
  readonly pick: (value: string | null | undefined) => boolean;
}

export function useOrchestratorColors(
  threads: ReadonlyArray<Parameters<typeof orchestratorThreadIds>[0][number]>,
) {
  const colors = useClientSettings((s) => s.sidebarOrchestratorColors);
  const updateClientSettings = useUpdateClientSettings();
  // The menus run from context-menu handlers and apply a pick after an await,
  // so they read the latest committed colors without changing identity.
  const applyColor = useStableCallback(
    (projectKeys: ReadonlyArray<string>, color: SidebarOrchestratorColor | null) =>
      updateClientSettings({
        sidebarOrchestratorColors: withOrchestratorColor(colors, projectKeys, color),
      }),
  );
  const pickFor = (projectKeys: ReadonlyArray<string>) => (value: string | null | undefined) => {
    const color = parseOrchestratorColorMenuId(value);
    if (color === undefined) return false;
    if (projectKeys.length > 0) applyColor(projectKeys, color);
    return true;
  };
  const orchestratorIds = orchestratorThreadIds(threads);

  /** An orchestrator's thread menu sets its project's tint. */
  const threadMenu = useStableCallback(
    (
      thread: ColorThread,
      projectByKey: ProjectByKey,
    ): OrchestratorColorMenu<{ current: SidebarOrchestratorColor | null } | null> => {
      const project = projectOf(thread, projectByKey);
      const key =
        project && orchestratorIds.has(thread.id) ? derivePhysicalProjectKey(project) : null;
      return {
        input: key ? { current: colors[key] ?? null } : null,
        pick: pickFor(key ? [key] : []),
      };
    },
  );

  /** A project group's tint applies to every member project, and shows as
      checked only when all members agree. */
  const groupMenu = useStableCallback(
    (
      projectKeys: ReadonlyArray<string>,
    ): OrchestratorColorMenu<ReturnType<typeof buildOrchestratorColorMenuItem>> => {
      const memberColors = projectKeys.map((key) => colors[key] ?? null);
      const current = memberColors.every((color) => color === memberColors[0])
        ? (memberColors[0] ?? null)
        : null;
      return { input: buildOrchestratorColorMenuItem(current), pick: pickFor(projectKeys) };
    },
  );

  /**
   * The tint class a row wears: set only on an unsettled orchestrator whose project picked one.
   * A settled one keeps counting as an orchestrator while its settled crew points at it, but its
   * row stops wearing the bar.
   */
  const tintClassName = (thread: ColorThread, projectByKey: ProjectByKey): string | undefined => {
    if (thread.settledOverride === "settled") return undefined;
    const project = projectOf(thread, projectByKey);
    const color =
      project && orchestratorIds.has(thread.id)
        ? colors[derivePhysicalProjectKey(project)]
        : undefined;
    return color ? orchestratorColorClassName(color) : undefined;
  };

  return { orchestratorIds, tintClassName, threadMenu, groupMenu };
}
