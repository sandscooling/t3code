// Fork: the "Group threads by project" sidebar. Sidebar.tsx renders the flat
// list; this hook folds the same sections into one group per project and hands
// back the grouped list items, row order and drag adapters. Every returned
// helper passes the flat list through untouched while grouping is off. The
// layout and drag model are described in Sidebar.groups.ts.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { readLocalApi } from "../localApi";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useUiStateStore } from "../uiStateStore";
import {
  arrangeSidebarGroupRows,
  buildGroupedSidebarListItems,
  isSidebarGroupMove,
  moveSidebarGroup,
  sidebarGroupId,
  sliceSidebarGroupForDrag,
  type SidebarGroupLead,
} from "./Sidebar.groups";
import {
  resolveSidebarThreadStatus,
  type SidebarListItem,
  type SidebarSection,
} from "./Sidebar.logic";
import { SidebarProjectGroupHeader } from "./SidebarProjectGroupHeader";
import type { useOrchestratorColors } from "./useOrchestratorColors";

// Folded project groups, and the group for threads whose project is gone.
const COLLAPSED_PROJECT_GROUPS_KEY = "t3code:sidebar:collapsed-project-groups";
const OTHER_PROJECT_GROUP_ID = "~other";
const CollapsedProjectGroupIds = Schema.Array(Schema.String);

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export interface SidebarThreadGroup {
  readonly id: string;
  readonly project: SidebarProjectSnapshot | null;
  readonly collapsed: boolean;
  readonly lead: ReadonlyArray<SidebarGroupLead<EnvironmentThreadShell>>;
  readonly pinned: readonly EnvironmentThreadShell[];
  readonly active: readonly EnvironmentThreadShell[];
  readonly snoozedCount: number;
  readonly visibleSnoozed: readonly EnvironmentThreadShell[];
  readonly workingCount: number;
}

export function useSidebarProjectGroups(input: {
  /** Grouping is on and no project scope narrows the list. */
  readonly enabled: boolean;
  /** In saved order: groups never move with activity. */
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly pinnedThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly snoozedThreads: readonly EnvironmentThreadShell[];
  readonly renderedSettledThreads: readonly EnvironmentThreadShell[];
  readonly routeThreadKey: string | null;
  readonly snoozedShelfExpanded: boolean;
  readonly orchestratorColors: ReturnType<typeof useOrchestratorColors>;
}) {
  const {
    enabled,
    projectGroups,
    threads,
    pinnedThreads,
    activeThreads,
    snoozedThreads,
    renderedSettledThreads,
    routeThreadKey,
    snoozedShelfExpanded,
  } = input;
  const { orchestratorIds, groupMenu } = input.orchestratorColors;
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const setProjectOrder = useUiStateStore((store) => store.setProjectOrder);

  const groupIdByProjectRef = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjectRefs.map(
            (ref) =>
              [`${ref.environmentId}:${ref.projectId}`, sidebarGroupId(group.projectKey)] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  // A folded group keeps the open thread, the same exception the shelves
  // make, and its pinned orchestrators.
  const [collapsedProjectGroupIds, setCollapsedProjectGroupIds] = useLocalStorage(
    COLLAPSED_PROJECT_GROUPS_KEY,
    [] as readonly string[],
    CollapsedProjectGroupIds,
  );
  const toggleGroup = useCallback(
    (group: string) =>
      setCollapsedProjectGroupIds((ids) =>
        ids.includes(group) ? ids.filter((id) => id !== group) : [...ids, group],
      ),
    [setCollapsedProjectGroupIds],
  );

  // Rows per project group, in project order.
  const groups = useMemo((): readonly SidebarThreadGroup[] | null => {
    if (!enabled) return null;
    const groupIdOf = (thread: EnvironmentThreadShell) =>
      groupIdByProjectRef.get(`${thread.environmentId}:${thread.projectId}`) ??
      OTHER_PROJECT_GROUP_ID;
    const buckets = new Map<
      string,
      {
        pinned: EnvironmentThreadShell[];
        active: EnvironmentThreadShell[];
        snoozed: EnvironmentThreadShell[];
      }
    >();
    const bucketOf = (thread: EnvironmentThreadShell) => {
      const id = groupIdOf(thread);
      let bucket = buckets.get(id);
      if (bucket === undefined) {
        bucket = { pinned: [], active: [], snoozed: [] };
        buckets.set(id, bucket);
      }
      return bucket;
    };
    for (const thread of pinnedThreads) bucketOf(thread).pinned.push(thread);
    for (const thread of activeThreads) bucketOf(thread).active.push(thread);
    for (const thread of snoozedThreads) bucketOf(thread).snoozed.push(thread);
    const collapsed = new Set(collapsedProjectGroupIds);
    const isRoute = (thread: EnvironmentThreadShell) => threadKeyOf(thread) === routeThreadKey;
    const entries: ReadonlyArray<{ id: string; project: SidebarProjectSnapshot | null }> = [
      ...projectGroups.map((project) => ({ id: sidebarGroupId(project.projectKey), project })),
      { id: OTHER_PROJECT_GROUP_ID, project: null },
    ];
    return entries.flatMap(({ id, project }) => {
      const bucket = buckets.get(id);
      if (bucket === undefined) return [];
      const isCollapsed = collapsed.has(id);
      // Orchestrators lead the group; a folded group keeps the pinned ones.
      const rows = arrangeSidebarGroupRows({
        ...bucket,
        collapsed: isCollapsed,
        isRoute,
        orchestratorIds,
      });
      return [
        {
          id,
          project,
          collapsed: isCollapsed,
          lead: rows.lead,
          pinned: rows.pinned,
          active: rows.active,
          snoozedCount: bucket.snoozed.length,
          visibleSnoozed: snoozedShelfExpanded ? rows.snoozed : bucket.snoozed.filter(isRoute),
          // A thread waiting on background work (v1's "monitoring") is still in flight.
          workingCount: [...bucket.pinned, ...bucket.active, ...bucket.snoozed].filter((thread) => {
            const status = resolveSidebarThreadStatus(thread);
            return status === "working" || status === "waiting";
          }).length,
        },
      ];
    });
  }, [
    activeThreads,
    collapsedProjectGroupIds,
    enabled,
    groupIdByProjectRef,
    orchestratorIds,
    pinnedThreads,
    projectGroups,
    routeThreadKey,
    snoozedShelfExpanded,
    snoozedThreads,
  ]);
  const groupById = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group])),
    [groups],
  );
  // Orchestrator rows leading a group are not drag handles and stay out of
  // every drag slice.
  const leadThreadKeys = useMemo(
    () => new Set((groups ?? []).flatMap((group) => group.lead.map(({ row }) => threadKeyOf(row)))),
    [groups],
  );

  // Groups keep the saved project order; this header menu is how it changes.
  const openGroupMenu = useCallback(
    (group: string, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api || groups === null) return;
        const visible = groups
          .map((entry) => entry.id)
          .filter((id) => id !== OTHER_PROJECT_GROUP_ID);
        const index = visible.indexOf(group);
        if (index === -1) return;
        const last = visible.length - 1;
        const memberKeys =
          projectGroups
            .find((project) => sidebarGroupId(project.projectKey) === group)
            ?.memberProjects.map((member) => member.physicalProjectKey) ?? [];
        const colorMenu = groupMenu(memberKeys);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "top", label: "Move to top", disabled: index === 0 },
              { id: "up", label: "Move up", disabled: index === 0 },
              { id: "down", label: "Move down", disabled: index === last },
              { id: "bottom", label: "Move to bottom", disabled: index === last },
              { ...colorMenu.input, separatorBefore: true },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        if (colorMenu.pick(clicked.value)) return;
        if (!isSidebarGroupMove(clicked.value)) return;
        const moved = moveSidebarGroup({
          order: projectGroups.map((project) => sidebarGroupId(project.projectKey)),
          visible: new Set(visible),
          item: group,
          move: clicked.value,
        });
        const membersById = new Map(
          projectGroups.map((project) => [
            sidebarGroupId(project.projectKey),
            project.memberProjects.map((member) => member.physicalProjectKey),
          ]),
        );
        // Every shown project gets an explicit spot, so a new project lands
        // below them. Saved keys for projects not loaded right now (another
        // environment offline) are kept after them.
        const keys = moved.flatMap((id) => membersById.get(id) ?? []);
        const placed = new Set(keys);
        setProjectOrder([...keys, ...projectOrder.filter((key) => !placed.has(key))]);
      })();
    },
    [groupMenu, groups, projectGroups, projectOrder, setProjectOrder],
  );

  // Null while the list is flat. Covers settled threads too, so a drag from
  // the shelf knows which group it may land in.
  const groupIdByThreadKey = useMemo(
    () =>
      enabled
        ? new Map(
            threads.map((thread) => [
              threadKeyOf(thread),
              groupIdByProjectRef.get(`${thread.environmentId}:${thread.projectId}`) ??
                OTHER_PROJECT_GROUP_ID,
            ]),
          )
        : null,
    [enabled, groupIdByProjectRef, threads],
  );

  const listItems = useMemo(
    () =>
      groups === null
        ? null
        : buildGroupedSidebarListItems({
            groups: groups.map((group) => ({
              id: group.id,
              collapsed: group.collapsed,
              lead: group.lead.map(({ row, section }) => ({ row: threadKeyOf(row), section })),
              pinned: group.pinned.map(threadKeyOf),
              active: group.active.map(threadKeyOf),
              hasSnoozed: group.snoozedCount > 0,
              visibleSnoozed: group.visibleSnoozed.map(threadKeyOf),
            })),
            settled: renderedSettledThreads.map(threadKeyOf),
          }),
    [groups, renderedSettledThreads],
  );
  const orderedThreads = useMemo(
    () =>
      groups === null
        ? null
        : [
            ...groups.flatMap((group) => [
              ...group.lead.map(({ row }) => row),
              ...group.pinned,
              ...group.active,
              ...group.visibleSnoozed,
            ]),
            ...renderedSettledThreads,
          ],
    [groups, renderedSettledThreads],
  );

  return useMemo(() => {
    const groupOf = (threadKey: string) => groupIdByThreadKey?.get(threadKey);
    /** Keeps only the keys in `threadKey`'s group; every key while flat. */
    const sameGroup = (keys: readonly string[], threadKey: string) =>
      groupIdByThreadKey === null
        ? keys
        : keys.filter((key) => groupIdByThreadKey.get(key) === groupOf(threadKey));
    // Grouped snoozed rows wake from their button, and a row whose group
    // shows no markers (folded) has nowhere to land.
    const canDragInGroup = (threadKey: string, section: SidebarSection) => {
      if (section === "snoozed") return false;
      const group = groupById.get(groupOf(threadKey) ?? "");
      return (
        group !== undefined &&
        (!group.collapsed ||
          group.pinned.length + group.active.length + group.visibleSnoozed.length > 0)
      );
    };
    return {
      listItems,
      orderedThreads,
      groupById,
      leadThreadKeys,
      groupOf,
      /** The header button inside a group's `group-header` marker. */
      renderGroupHeader: (groupId: string | undefined) => {
        const group = groupById.get(groupId ?? "");
        return group === undefined ? null : (
          <SidebarProjectGroupHeader
            group={group.id}
            project={group.project}
            collapsed={group.collapsed}
            workingCount={group.workingCount}
            onToggle={toggleGroup}
            onContextMenu={openGroupMenu}
          />
        );
      },
      sameGroup,
      /** Narrows a selector to the dragged thread's group; empty while flat. */
      groupSelector: (threadKey: string) => {
        const group = groupOf(threadKey);
        // Group ids are URI-encoded, so they never carry a quote.
        return group === undefined ? "" : `[data-sidebar-group="${group}"]`;
      },
      /** A grouped drag only sees its own group and the settled shelf. */
      dragItemsFor: (items: readonly SidebarListItem[], activeKey: string) =>
        groupIdByThreadKey === null
          ? items
          : sliceSidebarGroupForDrag(items, groupOf(activeKey), leadThreadKeys),
      /** A grouped drag plans against its own group's order, leads excluded. */
      dragOrderFor: (keys: readonly string[], activeKey: string) =>
        groupIdByThreadKey === null
          ? keys
          : sameGroup(keys, activeKey).filter((key) => !leadThreadKeys.has(key)),
      isDragLocked: (threadKey: string, section: SidebarSection) =>
        (groupIdByThreadKey !== null && !canDragInGroup(threadKey, section)) ||
        leadThreadKeys.has(threadKey),
    };
  }, [
    groupById,
    groupIdByThreadKey,
    leadThreadKeys,
    listItems,
    openGroupMenu,
    orderedThreads,
    toggleGroup,
  ]);
}
