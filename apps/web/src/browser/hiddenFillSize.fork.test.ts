import { describe, expect, it } from "vite-plus/test";

import { nextPanelSize, resolveForkHiddenBrowserViewportSize } from "./hiddenFillSize.fork";

const phone = { _tag: "preset", presetId: "iphone-12-pro", width: 390, height: 844 } as const;
const fill = { _tag: "fill" } as const;
const panelRect = { width: 1100, height: 760 };
const miniRect = { width: 320, height: 200 };

describe("nextPanelSize", () => {
  it("remembers only the panel's rect", () => {
    const panel = nextPanelSize(null, { active: true, rect: panelRect, fitSourceContent: false });
    expect(panel).toEqual(panelRect);
    expect(
      nextPanelSize(panel, { active: true, rect: { ...panelRect }, fitSourceContent: false }),
    ).toBe(panel);
    expect(nextPanelSize(panel, { active: true, rect: miniRect, fitSourceContent: true })).toBe(
      panel,
    );
    expect(nextPanelSize(panel, { active: false, rect: miniRect, fitSourceContent: false })).toBe(
      panel,
    );
    expect(
      nextPanelSize(null, { active: true, rect: miniRect, fitSourceContent: true }),
    ).toBeNull();
  });
});

describe("resolveForkHiddenBrowserViewportSize", () => {
  it("sizes a hidden fill tab from the last panel size, not a preset's published content", () => {
    expect(
      resolveForkHiddenBrowserViewportSize({
        setting: fill,
        zoomFactor: 1,
        lastPanelSize: panelRect,
      }),
    ).toEqual(panelRect);
    expect(
      resolveForkHiddenBrowserViewportSize({ setting: fill, zoomFactor: 1, lastPanelSize: null }),
    ).toEqual({ width: 1280, height: 800 });
  });

  it("sizes a hidden fixed viewport from the setting at the layout zoom", () => {
    expect(
      resolveForkHiddenBrowserViewportSize({
        setting: phone,
        zoomFactor: 1.25,
        lastPanelSize: panelRect,
      }),
    ).toEqual({ width: 487.5, height: 1055 });
  });
});
