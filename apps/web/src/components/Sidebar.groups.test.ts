import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";
import {
  buildGroupedSidebarListItems,
  createGroupedSidebarSortingStrategy,
  sidebarGroupId,
  sliceSidebarGroupForDrag,
} from "./Sidebar.groups";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
} from "./Sidebar.logic";

const group = (
  id: string,
  rows: Partial<{
    pinned: string[];
    active: string[];
    visibleSnoozed: string[];
    hasSnoozed: boolean;
    collapsed: boolean;
  }> = {},
) => ({
  id,
  collapsed: rows.collapsed ?? false,
  pinned: rows.pinned ?? [],
  active: rows.active ?? [],
  hasSnoozed: rows.hasSnoozed ?? (rows.visibleSnoozed ?? []).length > 0,
  visibleSnoozed: rows.visibleSnoozed ?? [],
});

const ids = (items: readonly SidebarListItem[]) => items.map(sidebarListItemId);

describe("grouped sidebar list", () => {
  it("nests each group's rows under its header and keeps one settled shelf last", () => {
    const items = buildGroupedSidebarListItems({
      groups: [
        group("a", { pinned: ["e:p1"], active: ["e:a1"], visibleSnoozed: ["e:s1"] }),
        group("b", { active: ["e:b1"] }),
      ],
      settled: ["e:x1"],
    });
    expect(ids(items)).toEqual([
      sidebarMarkerId("group-header", "a"),
      sidebarMarkerId("pinned-header", "a"),
      "e:p1",
      sidebarMarkerId("pinned-divider", "a"),
      sidebarMarkerId("active-placeholder", "a"),
      "e:a1",
      sidebarMarkerId("snoozed-header", "a"),
      "e:s1",
      sidebarMarkerId("group-header", "b"),
      sidebarMarkerId("pinned-header", "b"),
      sidebarMarkerId("pinned-divider", "b"),
      sidebarMarkerId("active-placeholder", "b"),
      "e:b1",
      sidebarMarkerId("settled-header"),
      sidebarMarkerId("settled-placeholder"),
      "e:x1",
    ]);
  });

  it("renders only the header of a folded group with no kept rows", () => {
    const items = buildGroupedSidebarListItems({
      groups: [group("a", { collapsed: true, hasSnoozed: true }), group("b", { active: ["e:b1"] })],
      settled: [],
    });
    expect(ids(items).slice(0, 2)).toEqual([
      sidebarMarkerId("group-header", "a"),
      sidebarMarkerId("group-header", "b"),
    ]);
  });

  it("gives group ids no colon, since scoped thread keys own it", () => {
    expect(sidebarGroupId("env-1:project/a b")).not.toContain(":");
    expect(sidebarGroupId("a:b")).not.toBe(sidebarGroupId("a_b"));
  });
});

describe("grouped sidebar drag slice", () => {
  const items = buildGroupedSidebarListItems({
    groups: [
      group("a", { pinned: ["e:p1"], active: ["e:a1", "e:a2"], visibleSnoozed: ["e:s1"] }),
      group("b", { pinned: ["e:bp"], active: ["e:b1"] }),
    ],
    settled: ["e:x1"],
  });

  it("keeps only the dragged group and the settled shelf", () => {
    expect(ids(sliceSidebarGroupForDrag(items, "b"))).toEqual([
      sidebarMarkerId("pinned-header", "b"),
      "e:bp",
      sidebarMarkerId("pinned-divider", "b"),
      sidebarMarkerId("active-placeholder", "b"),
      "e:b1",
      sidebarMarkerId("settled-header"),
      sidebarMarkerId("settled-placeholder"),
      "e:x1",
    ]);
  });

  it("resolves drops into the group's own order, never another group's", () => {
    const slice = sliceSidebarGroupForDrag(items, "a");
    expect(resolveSidebarDropTarget(slice, "e:a2", "e:p1")).toEqual({
      section: "pinned",
      pinnedOrder: ["e:a2", "e:p1"],
      activeOrder: ["e:a1"],
    });
    // Rows from other groups are not in the slice, so they are not targets.
    expect(resolveSidebarDropTarget(slice, "e:a2", "e:b1")).toBeNull();
  });
});

describe("grouped sidebar sorting strategy", () => {
  function heightOf(item: SidebarListItem) {
    if (item.kind === "thread") return item.section === "settled" ? 36 : 82;
    if (item.marker === "group-header" || item.marker.endsWith("header")) {
      return item.marker === "pinned-header" ? 0 : 32;
    }
    return 0;
  }

  function preview(
    items: readonly SidebarListItem[],
    groupId: string,
    active: string,
    over: string,
  ) {
    let top = 100;
    const rects = items.map((item) => {
      const height = heightOf(item);
      const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
      top += height + 1;
      return rect;
    });
    const activeIndex = ids(items).indexOf(active);
    const args = {
      activeIndex,
      overIndex: ids(items).indexOf(over),
      activeNodeRect: rects[activeIndex]!,
      rects,
      index: 0,
    } satisfies Parameters<SortingStrategy>[0];
    const strategy = createGroupedSidebarSortingStrategy({
      items,
      group: groupId,
      settledOrder: [],
      settledExpanded: true,
      boundaryLabelHeight: 24,
    });
    return new Map(
      items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
    );
  }

  const items = buildGroupedSidebarListItems({
    groups: [
      group("top", { active: ["e:t1"] }),
      group("a", { active: ["e:a1", "e:a2"] }),
      group("b", { active: ["e:b1"] }),
    ],
    settled: ["e:x1"],
  });

  it("moves the groups below by the same amount as the settled shelf", () => {
    const transforms = preview(items, "a", "e:a1", sidebarMarkerId("settled-header"));
    const shelfY = transforms.get(sidebarMarkerId("settled-header"))?.y;
    expect(shelfY).toBeDefined();
    expect(shelfY).not.toBe(0);
    expect(transforms.get(sidebarMarkerId("group-header", "b"))?.y).toBe(shelfY);
    expect(transforms.get("e:b1")?.y).toBe(shelfY);
  });

  it("leaves groups above the dragged group in place", () => {
    const transforms = preview(items, "a", "e:a1", sidebarMarkerId("settled-header"));
    expect(transforms.get(sidebarMarkerId("group-header", "top"))).toBeNull();
    expect(transforms.get("e:t1")).toBeNull();
    expect(transforms.get(sidebarMarkerId("group-header", "a"))).toBeNull();
  });
});
