import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  htmlRenderSightings,
  isQuestionPageTitle,
  nextQuestionHtmlRenderOpen,
  questionHtmlRender,
} from "./htmlRenderPanel.fork";

const THREAD = "env:thread-a";

describe("isQuestionPageTitle", () => {
  it("accepts Q, digits, then a space or the end", () => {
    for (const title of ["Q1", "Q12", "Q12 Where the page sits", "Q3 "]) {
      expect(isQuestionPageTitle(title)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const title of ["Q", "Qa", "Quarterly report", "q1", "Q1a", "Q1:", " Q1", ""]) {
      expect(isQuestionPageTitle(title)).toBe(false);
    }
  });
});

function page(title: string, visibleAt: string, attachmentId = title) {
  return { visibleAt: Date.parse(visibleAt), htmlRender: { attachmentId, title, height: 400 } };
}

describe("questionHtmlRender", () => {
  const q1 = page("Q1 Pick a database", "2026-10-07T12:00:01.000Z");
  const q10 = page("Q10 Pick a queue", "2026-10-07T12:00:02.000Z");
  const q2 = page("Q2", "2026-10-07T12:00:03.000Z");

  it("matches a title that starts with the header and a space", () => {
    expect(questionHtmlRender([q1, q10, q2], "Q1")?.attachmentId).toBe(q1.htmlRender.attachmentId);
  });

  it("matches a title that is exactly the header", () => {
    expect(questionHtmlRender([q1, q10, q2], "Q2")?.attachmentId).toBe("Q2");
  });

  it("never lets Q1 claim Q10", () => {
    expect(questionHtmlRender([q10], "Q1")).toBeNull();
    expect(questionHtmlRender([q1, q10], "Q10")?.attachmentId).toBe(q10.htmlRender.attachmentId);
  });

  it("picks the newest of several matches", () => {
    const redo = page("Q1 Pick a database (revised)", "2026-10-07T12:05:00.000Z", "redo");
    expect(questionHtmlRender([redo, q1, q10], "Q1")?.attachmentId).toBe("redo");
  });

  it("finds nothing when no question page title matches", () => {
    expect(questionHtmlRender([q1, q10, q2], "Q3")).toBeNull();
    // A page without a Q title stays inline, even when its title starts with the header.
    const schema = page("Database schema", "2026-10-07T12:00:04.000Z");
    expect(questionHtmlRender([schema], "Database")).toBeNull();
    expect(
      questionHtmlRender([page("Database", "2026-10-07T12:00:04.000Z")], "Database"),
    ).toBeNull();
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
    expect(sightings.map((sighting) => sighting.htmlRender.attachmentId)).toEqual(["Q1 ok"]);
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
