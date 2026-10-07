import { describe, expect, it } from "vite-plus/test";

import {
  type HtmlRenderAutoOpenState,
  type HtmlRenderSighting,
  nextHtmlRenderAutoOpen,
} from "./htmlRenderPanel.fork";

const VIEWED_AT = Date.parse("2026-10-07T12:00:00.000Z");
const THREAD = "env:thread-a";

function render(attachmentId: string, visibleAt: string): HtmlRenderSighting {
  return { attachmentId, visibleAt: Date.parse(visibleAt) };
}

const OLD = render("old", "2026-10-07T11:00:00.000Z");

function viewing(renders: ReadonlyArray<HtmlRenderSighting>, threadKey = THREAD) {
  const first = nextHtmlRenderAutoOpen(null, {
    threadKey,
    enabled: true,
    now: VIEWED_AT,
    renders,
  });
  return first.state as HtmlRenderAutoOpenState;
}

function later(
  state: HtmlRenderAutoOpenState | null,
  renders: ReadonlyArray<HtmlRenderSighting>,
  options: { readonly now?: number; readonly enabled?: boolean; readonly threadKey?: string } = {},
) {
  return nextHtmlRenderAutoOpen(state, {
    threadKey: options.threadKey ?? THREAD,
    enabled: options.enabled ?? true,
    now: options.now ?? VIEWED_AT + 5_000,
    renders,
  });
}

describe("nextHtmlRenderAutoOpen", () => {
  it("opens nothing when a thread's history first appears", () => {
    const result = later(null, [OLD], { now: VIEWED_AT });
    expect(result.openAttachmentId).toBeNull();
    expect(result.state?.seen.has("old")).toBe(true);
  });

  it("opens a render that arrives while the thread is viewed", () => {
    const fresh = render("fresh", "2026-10-07T12:00:05.000Z");
    expect(later(viewing([OLD]), [OLD, fresh]).openAttachmentId).toBe("fresh");
  });

  it("opens a call that was still running when the user arrived", () => {
    // Started before the user switched in, completed after: it counts from completion.
    const inFlight = render("in-flight", "2026-10-07T12:00:03.000Z");
    expect(later(viewing([OLD]), [OLD, inFlight]).openAttachmentId).toBe("in-flight");
  });

  it("opens a render only once", () => {
    const fresh = render("fresh", "2026-10-07T12:00:05.000Z");
    const opened = later(viewing([OLD]), [OLD, fresh]);
    expect(
      later(opened.state, [OLD, fresh], { now: VIEWED_AT + 9_000 }).openAttachmentId,
    ).toBeNull();
  });

  it("opens only the newest of renders that arrive together", () => {
    const first = render("first", "2026-10-07T12:00:05.000Z");
    const second = render("second", "2026-10-07T12:00:06.000Z");
    expect(later(viewing([]), [second, first]).openAttachmentId).toBe("second");
  });

  it("keeps a thread loaded empty and filled later as history", () => {
    expect(later(viewing([]), [OLD], { now: VIEWED_AT + 500 }).openAttachmentId).toBeNull();
  });

  it("keeps an older history page as history", () => {
    const older = render("older", "2026-10-06T09:00:00.000Z");
    expect(later(viewing([OLD]), [older, OLD]).openAttachmentId).toBeNull();
  });

  it("does not open on a thread switch, even for renders made while away", () => {
    const madeWhileAway = render("away", "2026-10-07T12:30:00.000Z");
    const backAt = Date.parse("2026-10-07T13:00:00.000Z");
    const switched = later(viewing([OLD], "env:thread-b"), [OLD], { now: backAt });
    expect(switched.openAttachmentId).toBeNull();
    // A returning thread replays what it missed after it is already shown.
    const caughtUp = later(switched.state, [OLD, madeWhileAway], { now: backAt + 200 });
    expect(caughtUp.openAttachmentId).toBeNull();
  });

  it("marks renders seen without opening while the panel is unavailable", () => {
    const fresh = render("fresh", "2026-10-07T12:00:05.000Z");
    const narrow = later(viewing([OLD]), [OLD, fresh], { enabled: false });
    expect(narrow.openAttachmentId).toBeNull();
    // Widening the window afterwards does not open it late.
    expect(
      later(narrow.state, [OLD, fresh], { now: VIEWED_AT + 9_000 }).openAttachmentId,
    ).toBeNull();
  });

  it("forgets the thread when none is viewed", () => {
    const result = nextHtmlRenderAutoOpen(viewing([OLD]), {
      threadKey: null,
      enabled: true,
      now: VIEWED_AT,
      renders: [],
    });
    expect(result).toEqual({ state: null, openAttachmentId: null });
  });
});
