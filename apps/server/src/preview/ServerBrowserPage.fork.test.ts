import type { CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { CAPTURE_DEADLINE_MS, UNAVAILABLE_SCREENSHOT_PNG } from "./ServerBrowserPage.fork.ts";

/**
 * A one-frame page whose DOM answers but whose capture is whatever `capture`
 * returns. `dotted` is what the page draws as dots, read by upstream's
 * redaction through an isolated world on the page's own CDP session.
 */
const makePage = (
  capture: () => Promise<{ data: string }>,
  content: {
    readonly visibleText?: string;
    readonly tree?: string;
    readonly dotted?: ReadonlyArray<string>;
  } = {},
) => {
  const mainFrame = { parentFrame: () => null };
  const page = {
    on: vi.fn(),
    viewportSize: () => ({ width: 1280, height: 800 }),
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    evaluate: vi.fn(async () => ({
      url: "https://example.com/",
      title: "Example",
      loading: false,
      visibleText: content.visibleText ?? "Hello",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => content.tree ?? '- button "Go" [ref=e1]'),
  };
  const cdp = {
    send: vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") return capture();
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") return { result: { value: [...(content.dotted ?? [])] } };
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

  it("a text-only answer still masks what the page draws as dots", async () => {
    vi.useFakeTimers();
    const snapshot = ServerBrowserPage.snapshot(
      makePage(() => new Promise(() => {}), {
        visibleText: "Password hunter22 saved",
        tree: '- textbox "Password" [ref=e1]: hunter22',
        dotted: ["hunter22"],
      }),
    );
    await vi.advanceTimersByTimeAsync(CAPTURE_DEADLINE_MS);
    const result = await snapshot;
    expect(result.screenshot.data).toBe(UNAVAILABLE_SCREENSHOT_PNG);
    expect(result.visibleText).toMatch(/^\[Screenshot unavailable: .*\]\n\nPassword •+ saved$/);
    expect(result.accessibilityTree).toMatch(/textbox "Password" \[ref=t3-[\w-]+-e1\]: •+$/);
    expect(JSON.stringify(result)).not.toContain("hunter22");
  });

  it("a capture that answers in time is returned unchanged", async () => {
    // Upstream sizes the screenshot from its PNG header.
    const header = Buffer.alloc(24);
    header.write("IHDR", 12);
    header.writeUInt32BE(1280, 16);
    header.writeUInt32BE(800, 20);
    const png = header.toString("base64");
    const result = await ServerBrowserPage.snapshot(makePage(async () => ({ data: png })));
    expect(result.visibleText).toBe("Hello");
    expect(result.screenshot.data).toBe(png);
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
