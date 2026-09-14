// Fork: group the default sidebar by project.
//
// Each project gets a header followed by its own pinned, active and snoozed
// rows; one settled shelf sits below every group. The upstream drag code
// (Sidebar.drag, Sidebar.logic) assumes one flat list, so a drag only ever
// sees a slice of the grouped list: the dragged thread's own group plus the
// settled shelf. Other groups can never be a drop target, which keeps every
// order write inside one project.

import type { SortingStrategy } from "@dnd-kit/sortable";
import { createSidebarSortingStrategy } from "./Sidebar.drag";
import { sidebarListItemId, type SidebarListItem } from "./Sidebar.logic";

/** Marker namespace for one project group. Colon-free (thread keys own the
    colon) and unique per project key. */
export function sidebarGroupId(projectKey: string): string {
  return encodeURIComponent(projectKey);
}

export interface SidebarThreadGroupRows {
  readonly id: string;
  /** Folded groups render only rows the caller kept (the open thread). */
  readonly collapsed: boolean;
  readonly pinned: readonly string[];
  readonly active: readonly string[];
  /** Whether the group has snoozed threads, even when the shelf is closed. */
  readonly hasSnoozed: boolean;
  readonly visibleSnoozed: readonly string[];
}

export function buildGroupedSidebarListItems(input: {
  readonly groups: readonly SidebarThreadGroupRows[];
  readonly settled: readonly string[];
}): SidebarListItem[] {
  const items: SidebarListItem[] = [];
  for (const group of input.groups) {
    items.push({ kind: "marker", marker: "group-header", group: group.id });
    const rowCount = group.pinned.length + group.active.length + group.visibleSnoozed.length;
    if (group.collapsed && rowCount === 0) continue;
    const marker = (name: "pinned-header" | "pinned-divider" | "active-placeholder") =>
      items.push({ kind: "marker", marker: name, group: group.id });
    marker("pinned-header");
    for (const key of group.pinned) items.push({ kind: "thread", key, section: "pinned" });
    marker("pinned-divider");
    marker("active-placeholder");
    for (const key of group.active) items.push({ kind: "thread", key, section: "active" });
    if (group.hasSnoozed && !group.collapsed) {
      items.push({ kind: "marker", marker: "snoozed-header", group: group.id });
    }
    for (const key of group.visibleSnoozed) items.push({ kind: "thread", key, section: "snoozed" });
  }
  items.push({ kind: "marker", marker: "settled-header" });
  items.push({ kind: "marker", marker: "settled-placeholder" });
  for (const key of input.settled) items.push({ kind: "thread", key, section: "settled" });
  return items;
}

export type SidebarGroupMove = "top" | "up" | "down" | "bottom";

export function isSidebarGroupMove(value: string | null | undefined): value is SidebarGroupMove {
  return value === "top" || value === "up" || value === "down" || value === "bottom";
}

/** Moves one group within the saved group order, counting only the groups
    on screen: a project with no open threads has no header, so stepping past
    it would look like the menu did nothing. Hidden groups keep their place
    relative to their neighbours. */
export function moveSidebarGroup<T>(input: {
  readonly order: readonly T[];
  readonly visible: ReadonlySet<T>;
  readonly item: T;
  readonly move: SidebarGroupMove;
}): T[] {
  const { order, item, move } = input;
  const visible = order.filter((entry) => input.visible.has(entry));
  const from = visible.indexOf(item);
  if (from === -1) return [...order];
  const to =
    move === "top" ? 0 : move === "up" ? from - 1 : move === "down" ? from + 1 : visible.length - 1;
  if (to < 0 || to >= visible.length || to === from) return [...order];
  const rest = order.filter((entry) => entry !== item);
  const anchor = rest.indexOf(visible[to]!);
  rest.splice(to < from ? anchor : anchor + 1, 0, item);
  return rest;
}

/** The part of a grouped list one drag can reach: the group's pinned and
    active rows, then the shared settled shelf. Snoozed rows are left out, so
    grouped snoozed rows wake from their button rather than by dragging. */
export function sliceSidebarGroupForDrag(
  items: readonly SidebarListItem[],
  group: string | undefined,
): SidebarListItem[] {
  const slice: SidebarListItem[] = [];
  let current: string | undefined;
  let settled = false;
  for (const item of items) {
    if (item.kind === "marker" && item.marker === "group-header") {
      current = item.group;
      continue;
    }
    if (item.kind === "marker" && item.marker === "settled-header") settled = true;
    if (settled) {
      slice.push(item);
      continue;
    }
    if (group === undefined || current !== group) continue;
    if (item.kind === "marker" ? item.marker === "snoozed-header" : item.section === "snoozed") {
      continue;
    }
    slice.push(item);
  }
  return slice;
}

/** Run the upstream strategy on the drag slice. The settled rects are moved up
    to sit right under the group, so the upstream layout sees one contiguous
    list; the groups between them then shift by the same amount the settled
    shelf does, which keeps a growing group from covering the next one. */
export function createGroupedSidebarSortingStrategy(
  input: Parameters<typeof createSidebarSortingStrategy>[0] & { readonly group: string },
): SortingStrategy {
  const slice = sliceSidebarGroupForDrag(input.items, input.group);
  const fullIndexById = new Map(input.items.map((item, index) => [sidebarListItemId(item), index]));
  const fullIndexes = slice.map((item) => fullIndexById.get(sidebarListItemId(item))!);
  const sliceIndexByFull = new Map(fullIndexes.map((full, index) => [full, index]));
  const settledIndex = slice.findIndex(
    (item) => item.kind === "marker" && item.marker === "settled-header",
  );
  const groupEnd = settledIndex > 0 ? fullIndexes[settledIndex - 1]! : -1;
  const settledFullIndex = settledIndex === -1 ? -1 : fullIndexes[settledIndex]!;
  const inner = createSidebarSortingStrategy({ ...input, items: slice });
  let sourceRects: Parameters<SortingStrategy>[0]["rects"] | undefined;
  let sliceRects: Parameters<SortingStrategy>[0]["rects"] = [];

  return (args) => {
    if (args.rects !== sourceRects) {
      sourceRects = args.rects;
      const rects = fullIndexes.map((index) => args.rects[index]!);
      const before = rects[settledIndex - 1];
      const shelf = rects[settledIndex];
      const gap = before && shelf ? shelf.top - (before.bottom + 1) : 0;
      sliceRects = rects.map((rect, index) =>
        gap > 0 && index >= settledIndex
          ? { ...rect, top: rect.top - gap, bottom: rect.bottom - gap }
          : rect,
      );
    }
    const activeIndex = sliceIndexByFull.get(args.activeIndex);
    if (activeIndex === undefined || groupEnd === -1) return null;
    const overIndex = sliceIndexByFull.get(args.overIndex) ?? activeIndex;
    const project = (index: number) =>
      inner({ ...args, rects: sliceRects, activeIndex, overIndex, index });
    const own = sliceIndexByFull.get(args.index);
    if (own !== undefined) return project(own);
    if (args.index > groupEnd && args.index < settledFullIndex) {
      const shelf = project(settledIndex);
      return shelf === null ? null : { x: 0, y: shelf.y, scaleX: 1, scaleY: 1 };
    }
    return null;
  };
}
