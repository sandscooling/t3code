import { describe, expect, it } from "@effect/vitest";

import { pickPreviewSnapshotSections, selectPreviewSnapshotSections } from "./snapshotSections.ts";

const fullPage = {
  url: "https://example.test/",
  title: "Example",
  loading: false,
  visibleText: "hello",
  interactiveElements: [{ tag: "button" }],
  accessibilityTree: { nodes: [{ role: "button" }] },
  consoleEntries: [{ level: "log", text: "ready" }],
  networkEntries: [{ url: "https://example.test/api" }],
  actionTimeline: [{ phase: "click" }],
};

describe("selectPreviewSnapshotSections", () => {
  it("defaults to every section when include is absent", () => {
    for (const payload of [undefined, null, {}, { tabId: "tab_1" }]) {
      const selected = selectPreviewSnapshotSections(payload);
      expect(selected.has("screenshot")).toBe(true);
      expect(selected.has("accessibilityTree")).toBe(true);
      expect(selected.size).toBe(6);
    }
  });

  it("honours an explicit selection", () => {
    const selected = selectPreviewSnapshotSections({
      include: ["screenshot", "interactiveElements"],
    });
    expect([...selected].toSorted()).toEqual(["interactiveElements", "screenshot"]);
  });

  it("falls back to every section rather than returning an empty snapshot", () => {
    // An empty or junk include is a bad argument, and a snapshot with every
    // section stripped would read as a broken page instead.
    expect(selectPreviewSnapshotSections({ include: [] }).size).toBe(6);
    expect(selectPreviewSnapshotSections({ include: ["nonsense"] }).size).toBe(6);
    expect(selectPreviewSnapshotSections({ include: "screenshot" }).size).toBe(6);
  });
});

describe("pickPreviewSnapshotSections", () => {
  it("keeps the page identity keys whatever is requested", () => {
    const picked = pickPreviewSnapshotSections(fullPage, new Set(["screenshot"]));
    expect(picked).toEqual({
      url: "https://example.test/",
      title: "Example",
      loading: false,
    });
  });

  it("drops the sections that were not asked for", () => {
    const picked = pickPreviewSnapshotSections(fullPage, new Set(["interactiveElements"]));
    expect(picked["interactiveElements"]).toEqual([{ tag: "button" }]);
    expect(picked["accessibilityTree"]).toBeUndefined();
    expect(picked["visibleText"]).toBeUndefined();
    expect(picked["actionTimeline"]).toBeUndefined();
  });

  it("maps diagnostics onto both of its payload keys", () => {
    const picked = pickPreviewSnapshotSections(fullPage, new Set(["diagnostics"]));
    expect(picked["consoleEntries"]).toEqual([{ level: "log", text: "ready" }]);
    expect(picked["networkEntries"]).toEqual([{ url: "https://example.test/api" }]);
  });

  it("returns everything when every section is requested", () => {
    const picked = pickPreviewSnapshotSections(fullPage, selectPreviewSnapshotSections({}));
    expect(picked).toEqual(fullPage);
  });
});
