// Fork: the tint an orchestrator's sidebar card wears, set per project from the
// thread menu or a project group header's menu. Sidebar.tsx keeps the call sites.
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarOrchestratorColor } from "@t3tools/contracts/settings";
import { useCallback, useMemo, useRef } from "react";

import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
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
  const orchestratorIds = useMemo(() => orchestratorThreadIds(threads), [threads]);
  // Refs so the context menu handlers read the latest without re-creating.
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const orchestratorIdsRef = useRef(orchestratorIds);
  orchestratorIdsRef.current = orchestratorIds;

  const pickFor = useCallback(
    (projectKeys: ReadonlyArray<string>) => (value: string | null | undefined) => {
      const color = parseOrchestratorColorMenuId(value);
      if (color === undefined) return false;
      if (projectKeys.length > 0) {
        updateClientSettings({
          sidebarOrchestratorColors: withOrchestratorColor(colorsRef.current, projectKeys, color),
        });
      }
      return true;
    },
    [updateClientSettings],
  );

  /** The tint class a row wears: set only on an orchestrator whose project picked one. */
  const tintClassName = useCallback(
    (thread: ColorThread, projectByKey: ProjectByKey): string | undefined => {
      const project = projectOf(thread, projectByKey);
      const color =
        project && orchestratorIds.has(thread.id)
          ? colors[derivePhysicalProjectKey(project)]
          : undefined;
      return color ? orchestratorColorClassName(color) : undefined;
    },
    [colors, orchestratorIds],
  );

  /** An orchestrator's thread menu sets its project's tint. */
  const threadMenu = useCallback(
    (
      thread: ColorThread,
      projectByKey: ProjectByKey,
    ): OrchestratorColorMenu<{ current: SidebarOrchestratorColor | null } | null> => {
      const project = projectOf(thread, projectByKey);
      const key =
        project && orchestratorIdsRef.current.has(thread.id)
          ? derivePhysicalProjectKey(project)
          : null;
      return {
        input: key ? { current: colorsRef.current[key] ?? null } : null,
        pick: pickFor(key ? [key] : []),
      };
    },
    [pickFor],
  );

  /** A project group's tint applies to every member project, and shows as
      checked only when all members agree. */
  const groupMenu = useCallback(
    (
      projectKeys: ReadonlyArray<string>,
    ): OrchestratorColorMenu<ReturnType<typeof buildOrchestratorColorMenuItem>> => {
      const memberColors = projectKeys.map((key) => colorsRef.current[key] ?? null);
      const current = memberColors.every((color) => color === memberColors[0])
        ? (memberColors[0] ?? null)
        : null;
      return { input: buildOrchestratorColorMenuItem(current), pick: pickFor(projectKeys) };
    },
    [pickFor],
  );

  return { orchestratorIds, tintClassName, threadMenu, groupMenu };
}
