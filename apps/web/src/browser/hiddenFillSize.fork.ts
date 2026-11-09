import type { PreviewViewportSetting, PreviewViewportSize } from "@t3tools/contracts";

// Only the panel counts: a mini player (fitSourceContent) presents the same tab in a thumbnail.
export function nextPanelSize(
  previous: PreviewViewportSize | null,
  presentation: {
    readonly active: boolean;
    readonly rect: PreviewViewportSize | null;
    readonly fitSourceContent: boolean;
  },
): PreviewViewportSize | null {
  const { active, rect, fitSourceContent } = presentation;
  if (!active || !rect || fitSourceContent) return previous;
  return previous?.width === rect.width && previous.height === rect.height
    ? previous
    : { width: rect.width, height: rect.height };
}

// Upstream fill read the latest published content, which after a preset is the preset's size.
export function resolveForkHiddenBrowserViewportSize(input: {
  readonly setting: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly lastPanelSize: PreviewViewportSize | null;
}): PreviewViewportSize {
  const { setting, zoomFactor, lastPanelSize } = input;
  if (setting._tag !== "fill") {
    return { width: setting.width * zoomFactor, height: setting.height * zoomFactor };
  }
  return lastPanelSize ?? { width: 1280, height: 800 };
}
