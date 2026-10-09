import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  type HtmlRenderAutoOpenState,
  type HtmlRenderSighting,
  htmlRenderSightings,
  nextHtmlRenderAutoOpen,
  nextQuestionHtmlRenderOpen,
  questionHtmlRender,
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

function page(title: string, visibleAt: string, attachmentId = title) {
  return {
    attachmentId,
    visibleAt: Date.parse(visibleAt),
    htmlRender: { attachmentId, title, height: 400 },
  };
}

describe("questionHtmlRender", () => {
  const q1 = page("Q1 Pick a database", "2026-10-07T12:00:01.000Z");
  const q10 = page("Q10 Pick a queue", "2026-10-07T12:00:02.000Z");
  const q2 = page("Q2", "2026-10-07T12:00:03.000Z");

  it("matches a title that starts with the header and a space", () => {
    expect(questionHtmlRender([q1, q10, q2], "Q1")?.attachmentId).toBe(q1.attachmentId);
  });

  it("matches a title that is exactly the header", () => {
    expect(questionHtmlRender([q1, q10, q2], "Q2")?.attachmentId).toBe("Q2");
  });

  it("never lets Q1 claim Q10", () => {
    expect(questionHtmlRender([q10], "Q1")).toBeNull();
    expect(questionHtmlRender([q1, q10], "Q10")?.attachmentId).toBe(q10.attachmentId);
  });

  it("picks the newest of several matches", () => {
    const redo = page("Q1 Pick a database (revised)", "2026-10-07T12:05:00.000Z", "redo");
    expect(questionHtmlRender([redo, q1, q10], "Q1")?.attachmentId).toBe("redo");
  });

  it("finds nothing when no title matches", () => {
    expect(questionHtmlRender([q1, q10, q2], "Q3")).toBeNull();
    expect(questionHtmlRender([q1], "q1")).toBeNull();
    expect(questionHtmlRender([q1], "")).toBeNull();
  });
});

describe("htmlRenderSightings", () => {
  const at = DateTime.makeUnsafe("2026-10-07T12:00:00.000Z");
  const done = DateTime.makeUnsafe("2026-10-07T12:00:04.000Z");
  function toolItem(status: string, title: string, isError = false) {
    return {
      item: {
        type: "dynamic_tool",
        status,
        toolName: "html_render",
        output: { htmlRender: { attachmentId: title, title, height: 400 }, isError },
        createdAt: at,
        updatedAt: at,
        completedAt: status === "completed" ? done : null,
      },
    } as never;
  }

  it("keeps completed renders, timed by completion, and drops failed or running calls", () => {
    const sightings = htmlRenderSightings([
      toolItem("completed", "Q1 ok"),
      toolItem("failed", "Q1 failed"),
      toolItem("inProgress", "Q1 running"),
      toolItem("completed", "Q1 error result", true),
    ]);
    expect(sightings.map((sighting) => sighting.attachmentId)).toEqual(["Q1 ok"]);
    expect(sightings[0]?.visibleAt).toBe(Date.parse("2026-10-07T12:00:04.000Z"));
    expect(questionHtmlRender(sightings, "Q1")?.attachmentId).toBe("Q1 ok");
  });
});

describe("nextQuestionHtmlRenderOpen", () => {
  const q1 = JSON.stringify(["request-a", "q1-page"]);
  const q2 = JSON.stringify(["request-a", "q2-page"]);
  function step(
    state: Parameters<typeof nextQuestionHtmlRenderOpen>[0],
    target: string | null,
    options: { readonly threadKey?: string; readonly enabled?: boolean } = {},
  ) {
    return nextQuestionHtmlRenderOpen(state, {
      threadKey: options.threadKey ?? THREAD,
      enabled: options.enabled ?? true,
      target,
    });
  }
  const watching = () => step(null, null).state;

  it("opens the first question's page when a request arrives live", () => {
    expect(step(watching(), q1).open).toBe(true);
  });

  it("re-targets on Next and Previous, and stays put while the target holds", () => {
    const onQ2 = step(step(watching(), q1).state, q2);
    expect(onQ2.open).toBe(true);
    // An idle re-render, or the user closing the panel, changes nothing.
    expect(step(onQ2.state, q2).open).toBe(false);
    expect(step(onQ2.state, q1).open).toBe(true);
  });

  it("opens nothing when the user arrives at or returns to a round", () => {
    expect(step(null, q1).open).toBe(false);
    const away = step(step(watching(), q1).state, null, { threadKey: "env:thread-b" });
    expect(away.open).toBe(false);
    expect(step(away.state, q1).open).toBe(false);
  });

  it("does not open when only the panel's availability changes", () => {
    const narrow = step(watching(), q1, { enabled: false });
    expect(narrow.open).toBe(false);
    expect(step(narrow.state, q1).open).toBe(false);
  });

  it("opens nothing for a question without a page", () => {
    expect(step(step(watching(), q1).state, null).open).toBe(false);
  });
});

describe("newest-first while a question owns the panel", () => {
  it("marks another question's new page seen without opening it", () => {
    const q3 = render("q3-page", "2026-10-07T12:00:05.000Z");
    // The hook passes enabled: false while the active question has a matched page.
    const whileQ2 = later(viewing([OLD]), [OLD, q3], { enabled: false });
    expect(whileQ2.openAttachmentId).toBeNull();
    // Once the round ends it stays history, not a late pop-up.
    const after = later(whileQ2.state, [OLD, q3], { now: VIEWED_AT + 9_000 });
    expect(after.openAttachmentId).toBeNull();
  });
});
