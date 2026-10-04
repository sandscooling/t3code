// Fork-owned tests for CommandPalette.logic.test.ts.
import { describe, expect, it } from "vite-plus/test";

import {
  parseSessionSpawnQuery,
  resolveSessionCountCompletion,
  resolveSessionCountTarget,
} from "./CommandPalette.logic";

describe("parseSessionSpawnQuery", () => {
  it("leaves a plain project filter untouched", () => {
    expect(parseSessionSpawnQuery("fleet")).toEqual({ filterText: "fleet", count: null });
  });

  it("splits a trailing count off the filter", () => {
    expect(parseSessionSpawnQuery("fleet 5")).toEqual({ filterText: "fleet", count: 5 });
  });

  it("keeps the filter intact when the project name has inner spaces", () => {
    expect(parseSessionSpawnQuery("Fleet Cooling 3")).toEqual({
      filterText: "Fleet Cooling",
      count: 3,
    });
  });

  it("treats a bare number as a filter, since it names no project", () => {
    expect(parseSessionSpawnQuery("5")).toEqual({ filterText: "5", count: null });
  });

  it("ignores a count above the spawn limit rather than starting a runaway fleet", () => {
    expect(parseSessionSpawnQuery("fleet 99")).toEqual({ filterText: "fleet 99", count: null });
  });

  it("ignores a zero count", () => {
    expect(parseSessionSpawnQuery("fleet 0")).toEqual({ filterText: "fleet 0", count: null });
  });

  it("accepts an explicit single session", () => {
    expect(parseSessionSpawnQuery("fleet 1")).toEqual({ filterText: "fleet", count: 1 });
  });
});

describe("resolveSessionCountTarget", () => {
  const items = [
    { value: "new-thread-in:env:a", title: "T3 Code" },
    { value: "new-thread-in:env:b", title: "Fleet Cooling" },
  ];

  it("picks the highlighted row", () => {
    expect(resolveSessionCountTarget({ items, highlightedItemValue: "new-thread-in:env:b" })).toBe(
      items[1],
    );
  });

  it("falls back to the first match when nothing is highlighted yet", () => {
    // The list highlights its first match on its own, so Tab and Enter have to
    // act on it without the user arrowing down first.
    expect(resolveSessionCountTarget({ items, highlightedItemValue: null })).toBe(items[0]);
  });

  it("falls back to the first match when the highlight is stale", () => {
    expect(resolveSessionCountTarget({ items, highlightedItemValue: "gone" })).toBe(items[0]);
  });

  it("returns undefined for an empty list", () => {
    expect(resolveSessionCountTarget({ items: [], highlightedItemValue: null })).toBeUndefined();
  });
});

describe("resolveSessionCountCompletion", () => {
  it("completes to the target title with a trailing space", () => {
    expect(resolveSessionCountCompletion({ target: { title: "Fleet Cooling" }, count: null })).toBe(
      "Fleet Cooling ",
    );
  });

  it("keeps a count that was already typed", () => {
    expect(resolveSessionCountCompletion({ target: { title: "Fleet Cooling" }, count: 5 })).toBe(
      "Fleet Cooling 5",
    );
  });

  it("returns null with no target, so Tab stays a no-op", () => {
    expect(resolveSessionCountCompletion({ target: undefined, count: null })).toBeNull();
  });

  it("ignores a target whose title is not plain text", () => {
    expect(resolveSessionCountCompletion({ target: { title: null }, count: null })).toBeNull();
  });
});
