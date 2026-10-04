import type * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

type DisplayBounds = DesktopAppSettings.DesktopWindowBounds;

/**
 * Fork: Windows grows an edge-snapped window by a few px at fractional scaling,
 * and the grown bounds get saved, so DesktopWindow clamps them back with this
 * instead of dropping to the default size. Drop when upstream fixes it.
 *
 * Clamps bounds into the display they overlap most; null when they overlap none.
 * An overhang past the right or bottom edge is trimmed rather than shifted,
 * because Windows regrows the window each launch and shifting would walk it
 * across the screen.
 */
export function clampBoundsIntoMostOverlappedDisplay(
  bounds: DesktopAppSettings.DesktopWindowBounds,
  displays: readonly DisplayBounds[],
  minSize: { readonly width: number; readonly height: number },
): DesktopAppSettings.DesktopWindowBounds | null {
  let best: DisplayBounds | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const overlapWidth =
      Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
    const overlapHeight =
      Math.min(bounds.y + bounds.height, display.y + display.height) -
      Math.max(bounds.y, display.y);
    const area = Math.max(0, overlapWidth) * Math.max(0, overlapHeight);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  if (best === null) {
    return null;
  }
  const [x, width] = clampSpan(bounds.x, bounds.width, best.x, best.width, minSize.width);
  const [y, height] = clampSpan(bounds.y, bounds.height, best.y, best.height, minSize.height);
  return { x, y, width, height };
}

// Moves the start edge onto the display and trims the far edge to it; when the
// trim would go below the minimum size, shifts the span in from the far edge instead.
function clampSpan(
  start: number,
  size: number,
  displayStart: number,
  displaySize: number,
  minSize: number,
): readonly [start: number, size: number] {
  const clampedStart = Math.max(start, displayStart);
  const trimmedSize = Math.min(size, displayStart + displaySize - clampedStart);
  if (trimmedSize >= Math.min(size, minSize)) {
    return [clampedStart, trimmedSize];
  }
  const shiftedSize = Math.min(size, displaySize);
  return [displayStart + displaySize - shiftedSize, shiftedSize];
}
