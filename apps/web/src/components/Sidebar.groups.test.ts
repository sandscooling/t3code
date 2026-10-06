import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";
import {
  arrangeSidebarGroupRows,
  buildGroupedSidebarListItems,
  createGroupedSidebarSortingStrategy,
  moveSidebarGroup,
  sidebarGroupId,
  sliceSidebarGroupForDrag,
} from "./Sidebar.groups";
import { orchestratorThreadIds } from "./orchestratorColor.logic";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
} from "./Sidebar.logic";

const group = (
  id: string,
  rows: Partial<{
    lead: Array<{ row: string; section: "pinned" | "active" }>;
    pinned: string[];
    active: string[];
    visibleSnoozed: string[];
    hasSnoozed: boolean;
    collapsed: boolean;
  }> = {},
) => ({
  id,
  collapsed: rows.collapsed ?? false,
  lead: rows.lead ?? [],
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

describe("group rows", () => {
  // Both orchestrators have a child thread; open is the route thread.
  const threads = [
    { id: "pinnedOrch", title: "Orchestrator", spawnedByThreadId: null },
    { id: "activeOrch", title: "Orchestrator", spawnedByThreadId: null },
    { id: "worker", spawnedByThreadId: "pinnedOrch" },
    { id: "helper", spawnedByThreadId: "activeOrch" },
    { id: "pinnedLoose", spawnedByThreadId: null },
    { id: "open", spawnedByThreadId: null },
    { id: "snoozed", spawnedByThreadId: null },
  ];
  const byId = (id: string) => threads.find((thread) => thread.id === id)!;
  const arrange = (
    buckets: { pinned: string[]; active: string[]; snoozed?: string[] },
    collapsed = false,
    route = "open",
  ) => {
    const rows = arrangeSidebarGroupRows({
      pinned: buckets.pinned.map(byId),
      active: buckets.active.map(byId),
      snoozed: (buckets.snoozed ?? []).map(byId),
      collapsed,
      isRoute: (thread) => thread.id === route,
      orchestratorIds: orchestratorThreadIds(threads),
    });
    const idsOf = (list: readonly { id: string }[]) => list.map((thread) => thread.id);
    return {
      lead: rows.lead.map(({ row, section }) => `${row.id}:${section}`),
      pinned: idsOf(rows.pinned),
      active: idsOf(rows.active),
      snoozed: idsOf(rows.snoozed),
    };
  };
  const buckets = {
    pinned: ["pinnedLoose", "pinnedOrch"],
    active: ["worker", "activeOrch", "open"],
    snoozed: ["snoozed"],
  };

  it("lifts orchestrators to lead the group whether pinned or not, pinned first", () => {
    expect(arrange(buckets)).toEqual({
      lead: ["pinnedOrch:pinned", "activeOrch:active"],
      pinned: ["pinnedLoose"],
      active: ["worker", "open"],
      snoozed: ["snoozed"],
    });
  });

  it("puts an unpinned orchestrator ahead of the group's pinned threads", () => {
    expect(arrange({ pinned: ["pinnedLoose"], active: ["worker", "activeOrch"] })).toEqual({
      lead: ["activeOrch:active"],
      pinned: ["pinnedLoose"],
      active: ["worker"],
      snoozed: [],
    });
  });

  it("keeps two orchestrators in their existing order during a handoff", () => {
    expect(arrange({ pinned: [], active: ["activeOrch", "worker", "pinnedOrch"] }).lead).toEqual([
      "activeOrch:active",
      "pinnedOrch:active",
    ]);
  });

  it("keeps only the open thread and pinned orchestrators when folded", () => {
    expect(arrange(buckets, true)).toEqual({
      lead: ["pinnedOrch:pinned"],
      pinned: [],
      active: ["open"],
      snoozed: [],
    });
  });

  it("keeps an unpinned orchestrator in a folded group only while it is open", () => {
    const folded = { pinned: [], active: ["activeOrch"] };
    expect(arrange(folded, true).lead).toEqual([]);
    expect(arrange(folded, true, "activeOrch").lead).toEqual(["activeOrch:active"]);
  });

  it("leaves a group with no orchestrator exactly as it was", () => {
    const plain = { pinned: ["pinnedLoose"], active: ["open"], snoozed: ["snoozed"] };
    expect(arrange(plain)).toEqual({ lead: [], ...plain });
    expect(arrange(plain, true)).toEqual({ lead: [], pinned: [], active: ["open"], snoozed: [] });
  });
});

describe("orchestrator rows in the grouped list", () => {
  const groups = [
    group("a", { lead: [{ row: "e:ao", section: "active" }], active: ["e:a1"] }),
    group("b", { lead: [{ row: "e:bo", section: "pinned" }], pinned: ["e:bp"], active: ["e:b1"] }),
  ];
  const lead = new Set(["e:ao", "e:bo"]);

  it("puts each group's orchestrator rows first under its header, in their own section", () => {
    const items = buildGroupedSidebarListItems({ groups, settled: [] });
    expect(ids(items).slice(0, 9)).toEqual([
      sidebarMarkerId("group-header", "a"),
      "e:ao",
      sidebarMarkerId("pinned-header", "a"),
      sidebarMarkerId("pinned-divider", "a"),
      sidebarMarkerId("active-placeholder", "a"),
      "e:a1",
      sidebarMarkerId("group-header", "b"),
      "e:bo",
      sidebarMarkerId("pinned-header", "b"),
    ]);
    expect(items[1]).toEqual({ kind: "thread", key: "e:ao", section: "active" });
  });

  it("keeps a folded group's pinned orchestrator under its bare header", () => {
    const items = buildGroupedSidebarListItems({
      groups: [
        group("a", { collapsed: true, lead: [{ row: "e:ao", section: "pinned" }] }),
        group("b", { active: ["e:b1"] }),
      ],
      settled: [],
    });
    expect(ids(items).slice(0, 3)).toEqual([
      sidebarMarkerId("group-header", "a"),
      "e:ao",
      sidebarMarkerId("group-header", "b"),
    ]);
  });

  it("moves a group together with its orchestrator rows", () => {
    const order = moveSidebarGroup({
      order: ["a", "b"],
      visible: new Set(["a", "b"]),
      item: "b",
      move: "up",
    });
    const groupById = new Map(groups.map((entry) => [entry.id, entry]));
    const items = ids(
      buildGroupedSidebarListItems({ groups: order.map((id) => groupById.get(id)!), settled: [] }),
    );
    expect(items.slice(0, 2)).toEqual([sidebarMarkerId("group-header", "b"), "e:bo"]);
    expect(items.indexOf("e:ao")).toBe(items.indexOf(sidebarMarkerId("group-header", "a")) + 1);
  });

  it("leaves orchestrator rows out of every drag slice", () => {
    const items = buildGroupedSidebarListItems({ groups, settled: [] });
    // a's orchestrator sits between a's header and its pinned header.
    expect(ids(sliceSidebarGroupForDrag(items, "a", lead))).toEqual([
      sidebarMarkerId("pinned-header", "a"),
      sidebarMarkerId("pinned-divider", "a"),
      sidebarMarkerId("active-placeholder", "a"),
      "e:a1",
      sidebarMarkerId("settled-header"),
      sidebarMarkerId("settled-placeholder"),
    ]);
    expect(ids(sliceSidebarGroupForDrag(items, "b", lead))).not.toContain("e:bo");
  });
});

describe("moving a project group", () => {
  // b and d have no open threads, so they have no header on screen.
  const order = ["a", "b", "c", "d", "e"];
  const visible = new Set(["a", "c", "e"]);
  const move = (item: string, direction: "top" | "up" | "down" | "bottom") =>
    moveSidebarGroup({ order, visible, item, move: direction });

  it("steps over hidden groups, so every move changes what is on screen", () => {
    expect(move("e", "up")).toEqual(["a", "b", "e", "c", "d"]);
    expect(move("a", "down")).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("moves to either end of the visible groups", () => {
    expect(move("c", "top")).toEqual(["c", "a", "b", "d", "e"]);
    expect(move("c", "bottom")).toEqual(["a", "b", "d", "e", "c"]);
  });

  it("leaves the order alone at an edge or for a group that is not shown", () => {
    expect(move("a", "up")).toEqual(order);
    expect(move("e", "bottom")).toEqual(order);
    expect(move("b", "top")).toEqual(order);
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
    lead: ReadonlySet<string> = new Set(),
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
      lead,
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

  it("keeps the dragged group's orchestrator in place and moves later ones with the shelf", () => {
    const withLead = buildGroupedSidebarListItems({
      groups: [
        group("a", { lead: [{ row: "e:ao", section: "active" }], active: ["e:a1", "e:a2"] }),
        group("b", { lead: [{ row: "e:bo", section: "active" }], active: ["e:b1"] }),
      ],
      settled: ["e:x1"],
    });
    const lead = new Set(["e:ao", "e:bo"]);
    const transforms = preview(withLead, "a", "e:a1", sidebarMarkerId("settled-header"), lead);
    const shelfY = transforms.get(sidebarMarkerId("settled-header"))?.y;
    expect(shelfY).not.toBe(0);
    expect(transforms.get("e:ao")).toBeNull();
    expect(transforms.get("e:bo")?.y).toBe(shelfY);
  });
});
