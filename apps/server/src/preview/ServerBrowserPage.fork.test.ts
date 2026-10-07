import type { CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { CAPTURE_DEADLINE_MS, UNAVAILABLE_SCREENSHOT_PNG } from "./ServerBrowserPage.fork.ts";

/** A page whose DOM answers but whose capture is whatever `capture` returns. */
const makePage = (capture: () => Promise<{ data: string }>) => {
  const page = {
    on: vi.fn(),
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: vi.fn(async () => ({
      url: "https://example.com/",
      title: "Example",
      loading: false,
      visibleText: "Hello",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "Go" [ref=e1]'),
  };
  const cdp = {
    send: vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return capture();
      throw new Error(`Unexpected ${method}`);
    }),
  };
  return {
    page: page as unknown as Page,
    cdp: cdp as unknown as CDPSession,
    renderScale: 2,
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
  };
};

describe("bounded captures", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a snapshot whose capture never settles still answers with its text", async () => {
    vi.useFakeTimers();
    const snapshot = ServerBrowserPage.snapshot(makePage(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(CAPTURE_DEADLINE_MS);
    const result = await snapshot;
    expect(result.visibleText).toMatch(/^\[Screenshot unavailable: .*\]\n\nHello$/);
    expect(result.accessibilityTree).toContain('button "Go"');
    expect(result.screenshot).toEqual({
      mimeType: "image/png",
      data: UNAVAILABLE_SCREENSHOT_PNG,
      width: 1,
      height: 1,
    });
  });

  it("a capture that answers in time is returned unchanged", async () => {
    const result = await ServerBrowserPage.snapshot(makePage(async () => ({ data: "ZnJhbWU=" })));
    expect(result.visibleText).toBe("Hello");
    expect(result.screenshot.data).toBe("ZnJhbWU=");
    expect(result.screenshot.width).toBe(1280);
  });

  it("a capture that fails, rather than stalls, still fails the snapshot", async () => {
    const failing = makePage(async () => {
      throw new Error("Unable to capture screenshot");
    });
    await expect(ServerBrowserPage.snapshot(failing)).rejects.toThrow(
      "Unable to capture screenshot",
    );
  });

  it("a stalled capture on its own reports a timeout", async () => {
    vi.useFakeTimers();
    const { page, cdp } = makePage(() => new Promise(() => {}));
    const capture = ServerBrowserPage.captureViewport(page, cdp, { format: "jpeg", scale: 1 }).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(CAPTURE_DEADLINE_MS);
    expect(ServerBrowserPage.toOperationError(await capture).tag).toBe(
      "PreviewAutomationTimeoutError",
    );
  });
});
