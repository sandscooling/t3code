import { describe, expect, it } from "vite-plus/test";

import {
  type HtmlRenderAutoOpenState,
  type HtmlRenderSighting,
  nextHtmlRenderAutoOpen,
} from "./htmlRenderPanel.fork";

const VIEWED_AT = Date.parse("2026-10-07T12:00:00.000Z");

function render(attachmentId: string, createdAt: string): HtmlRenderSighting {
  return { attachmentId, createdAt };
}

const OLD = render("old", "2026-10-07T11:00:00.000Z");

function viewing(renders: ReadonlyArray<HtmlRenderSighting>, threadKey = "env:thread-a") {
  const first = nextHtmlRenderAutoOpen(null, { threadKey, now: VIEWED_AT, renders });
  return first.state as HtmlRenderAutoOpenState;
}

describe("nextHtmlRenderAutoOpen", () => {
  it("opens nothing when a thread's history first appears", () => {
    const result = nextHtmlRenderAutoOpen(null, {
      threadKey: "env:thread-a",
      now: VIEWED_AT,
      renders: [OLD],
    });
    expect(result.openAttachmentId).toBeNull();
    expect(result.state?.seen.has("old")).toBe(true);
  });

  it("opens a render that arrives while the thread is viewed", () => {
    const fresh = render("fresh", "2026-10-07T12:00:05.000Z");
    const result = nextHtmlRenderAutoOpen(viewing([OLD]), {
      threadKey: "env:thread-a",
      now: VIEWED_AT + 5_000,
      renders: [OLD, fresh],
    });
    expect(result.openAttachmentId).toBe("fresh");
  });

  it("opens a render only once", () => {
    const fresh = render("fresh", "2026-10-07T12:00:05.000Z");
    const opened = nextHtmlRenderAutoOpen(viewing([OLD]), {
      threadKey: "env:thread-a",
      now: VIEWED_AT + 5_000,
      renders: [OLD, fresh],
    });
    const again = nextHtmlRenderAutoOpen(opened.state, {
      threadKey: "env:thread-a",
      now: VIEWED_AT + 9_000,
      renders: [OLD, fresh],
    });
    expect(again.openAttachmentId).toBeNull();
  });

  it("opens only the newest of renders that arrive together", () => {
    const first = render("first", "2026-10-07T12:00:05.000Z");
    const second = render("second", "2026-10-07T12:00:06.000Z");
    const result = nextHtmlRenderAutoOpen(viewing([]), {
      threadKey: "env:thread-a",
      now: VIEWED_AT + 6_000,
      renders: [second, first],
    });
    expect(result.openAttachmentId).toBe("second");
  });

  it("keeps a thread loaded empty and filled later as history", () => {
    const result = nextHtmlRenderAutoOpen(viewing([]), {
      threadKey: "env:thread-a",
      now: VIEWED_AT + 500,
      renders: [OLD],
    });
    expect(result.openAttachmentId).toBeNull();
  });

  it("keeps an older history page as history", () => {
    const older = render("older", "2026-10-06T09:00:00.000Z");
    const result = nextHtmlRenderAutoOpen(viewing([OLD]), {
      threadKey: "env:thread-a",
      now: VIEWED_AT + 30_000,
      renders: [older, OLD],
    });
    expect(result.openAttachmentId).toBeNull();
  });

  it("does not open on a thread switch, even for renders made while away", () => {
    const madeWhileAway = render("away", "2026-10-07T12:30:00.000Z");
    const backAt = Date.parse("2026-10-07T13:00:00.000Z");
    const switched = nextHtmlRenderAutoOpen(viewing([OLD], "env:thread-b"), {
      threadKey: "env:thread-a",
      now: backAt,
      renders: [OLD],
    });
    expect(switched.openAttachmentId).toBeNull();
    // A returning thread replays what it missed after it is already shown.
    const caughtUp = nextHtmlRenderAutoOpen(switched.state, {
      threadKey: "env:thread-a",
      now: backAt + 200,
      renders: [OLD, madeWhileAway],
    });
    expect(caughtUp.openAttachmentId).toBeNull();
  });

  it("forgets the thread when none is viewed", () => {
    const result = nextHtmlRenderAutoOpen(viewing([OLD]), {
      threadKey: null,
      now: VIEWED_AT,
      renders: [],
    });
    expect(result).toEqual({ state: null, openAttachmentId: null });
  });
});
