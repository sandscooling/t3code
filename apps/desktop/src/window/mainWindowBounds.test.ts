import { assert, describe, it } from "@effect/vitest";

import type * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { clampBoundsIntoMostOverlappedDisplay } from "./mainWindowBounds.ts";

const MIN_SIZE = { width: 840, height: 620 };

const restore = (
  bounds: DesktopAppSettings.DesktopWindowBounds,
  displays: readonly DesktopAppSettings.DesktopWindowBounds[],
) => clampBoundsIntoMostOverlappedDisplay(bounds, displays, MIN_SIZE);

describe("clampBoundsIntoMostOverlappedDisplay", () => {
  // Windows grows an edge-snapped window a few px at fractional scaling.
  it("clamps saved bounds that overhang a display back into it", () => {
    const display = { x: 0, y: 0, width: 2752, height: 1152 };
    const clamp = (bounds: DesktopAppSettings.DesktopWindowBounds) =>
      clampBoundsIntoMostOverlappedDisplay(bounds, [display], MIN_SIZE);

    assert.deepEqual(clamp({ x: 900, y: 0, width: 1858, height: 1105 }), {
      x: 900,
      y: 0,
      width: 1852,
      height: 1105,
    });
    assert.deepEqual(clamp({ x: -100, y: 50, width: 1000, height: 800 }), {
      x: 0,
      y: 50,
      width: 1000,
      height: 800,
    });
    assert.deepEqual(clamp({ x: 2400, y: 0, width: 1000, height: 800 }), {
      x: 1752,
      y: 0,
      width: 1000,
      height: 800,
    });
    const fitting = { x: 900, y: 0, width: 1852, height: 1104 };
    assert.deepEqual(clamp(fitting), fitting);
    assert.deepEqual(clamp({ x: -10, y: -10, width: 3000, height: 1300 }), {
      x: 0,
      y: 0,
      width: 2752,
      height: 1152,
    });
    assert.deepEqual(
      clampBoundsIntoMostOverlappedDisplay(
        { x: 1700, y: 100, width: 1000, height: 800 },
        [
          { x: 0, y: 0, width: 1920, height: 1080 },
          { x: 1920, y: 0, width: 2560, height: 1440 },
        ],
        MIN_SIZE,
      ),
      { x: 1920, y: 100, width: 1000, height: 800 },
    );
    assert.strictEqual(
      clampBoundsIntoMostOverlappedDisplay(
        { x: 5000, y: 0, width: 1000, height: 800 },
        [
          { x: 0, y: 0, width: 1920, height: 1080 },
          { x: 1920, y: 0, width: 2560, height: 1440 },
        ],
        MIN_SIZE,
      ),
      null,
    );
  });

  it("restores the same bounds on every launch while Windows keeps regrowing the window", () => {
    const display = { x: 0, y: 0, width: 2752, height: 1152 };
    const restored = { x: 900, y: 0, width: 1852, height: 1105 };
    assert.deepEqual(restore({ x: 900, y: 0, width: 1858, height: 1105 }, [display]), restored);

    // Windows regrows the restored window by 6 px, and that is what gets saved.
    const savedAfterRegrowth = { ...restored, width: restored.width + 6 };
    assert.deepEqual(restore(savedAfterRegrowth, [display]), restored);
  });

  it("does not drift a window snapped to the right, bottom, or corner across launches", () => {
    const displays = [
      { x: -1920, y: -1080, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 2752, height: 1152 },
    ];
    const cases = [
      { bounds: { x: 900, y: 20, width: 1852, height: 1000 }, right: true, bottom: false },
      { bounds: { x: 100, y: 52, width: 1200, height: 1100 }, right: false, bottom: true },
      { bounds: { x: 900, y: 47, width: 1852, height: 1105 }, right: true, bottom: true },
      { bounds: { x: -1020, y: -780, width: 1020, height: 780 }, right: true, bottom: true },
    ];
    for (const { bounds, right, bottom } of cases) {
      let saved: DesktopAppSettings.DesktopWindowBounds = bounds;
      for (let launch = 0; launch < 5; launch++) {
        const restored = restore(saved, displays);
        assert.ok(restored !== null);
        if (right) {
          assert.deepEqual([restored.x, restored.width], [bounds.x, bounds.width]);
        }
        if (bottom) {
          assert.deepEqual([restored.y, restored.height], [bounds.y, bounds.height]);
        }
        // Windows regrows the restored window, and that is what gets saved.
        saved = { ...restored, width: restored.width + 6, height: restored.height + 1 };
      }
    }
  });
});
