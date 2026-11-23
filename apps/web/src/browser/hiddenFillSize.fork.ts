import type { PreviewViewportSetting, PreviewViewportSize } from "@t3tools/contracts";

import { resolveHiddenBrowserViewportSize } from "./browserViewportLayout";

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

// Upstream fill reads the latest published content, which after a preset is the preset's size.
export function resolveForkHiddenBrowserViewportSize(input: {
  readonly setting: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly lastPanelSize: PreviewViewportSize | null;
  readonly windowSize: { readonly width: number; readonly height: number };
}): { readonly width: number; readonly height: number } {
  return resolveHiddenBrowserViewportSize({
    setting: input.setting,
    zoomFactor: input.zoomFactor,
    content: null,
    lastRect: input.lastPanelSize,
    windowSize: input.windowSize,
  });
}
