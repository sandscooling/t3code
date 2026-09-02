import { describe, expect, it } from "vite-plus/test";

import { partitionComposerBanners, type ComposerBannerStackEntry } from "./ComposerBannerStack";

function banner(
  id: string,
  overrides: Partial<ComposerBannerStackEntry> = {},
): ComposerBannerStackEntry {
  return { id, variant: "default", content: null, ...overrides } as ComposerBannerStackEntry;
}

describe("partitionComposerBanners", () => {
  it("pins every activity banner so background work keeps its Stop button visible", () => {
    const activity = banner("composer-activity", { priority: "activity" });
    const backgroundWork = banner("background-liveness", { priority: "activity" });
    const notice = banner("thread-woke", { variant: "info" });

    const { pinnedItems, stackedItems } = partitionComposerBanners([
      activity,
      backgroundWork,
      notice,
    ]);

    expect(pinnedItems).toEqual([activity, backgroundWork]);
    expect(stackedItems).toEqual([notice]);
  });

  it("attaches the composer activity strip first, so later activity sits above it", () => {
    const backgroundWork = banner("background-liveness", { priority: "activity" });
    const activity = banner("composer-activity", { priority: "activity" });

    const { pinnedItems } = partitionComposerBanners([activity, backgroundWork]);

    expect(pinnedItems[0]).toBe(activity);
  });

  it("attaches the front notice when no activity banner is live", () => {
    const warning = banner("git-warning", { variant: "warning" });
    const info = banner("thread-woke", { variant: "info" });

    const { pinnedItems, stackedItems } = partitionComposerBanners([info, warning]);

    expect(pinnedItems).toEqual([warning]);
    expect(stackedItems).toEqual([info]);
  });
});
