// Fork-owned: agent HTML renders open in the right panel instead of inline.
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { htmlRenderFileName, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { DateTime } from "effect";
import { useEffect, useMemo, useRef } from "react";

import type { PendingUserInput } from "~/session-logic";
import type { ChatFileAttachment } from "~/types";

/** The panel attachment for a render, the same one the inline frame's "Open in panel" builds. */
export function htmlRenderAttachment(
  htmlRender: Pick<HtmlRenderReference, "attachmentId" | "title">,
): ChatFileAttachment {
  return {
    type: "file",
    id: htmlRender.attachmentId,
    name: htmlRenderFileName(htmlRender.title),
    mimeType: "text/html",
    // Unknown here; the preview leaves it out.
    sizeBytes: 0,
    htmlRender: true,
  };
}

export interface HtmlRenderSighting {
  readonly attachmentId: string;
  /** When the `html_render` call completed and the page appeared, in epoch milliseconds. */
  readonly visibleAt: number;
  readonly title: string;
}

/**
 * Whether a render title names a question round's page: "Q", digits, then a
 * space or the end ("Q1", "Q12 Where the page sits"). Such pages are published
 * ahead of the question card and open only when their question is on screen.
 */
export function isQuestionPageTitle(title: string): boolean {
  return /^Q\d+(?: |$)/.test(title);
}

/** The thread's completed html_render pages, timed by completion: a row's createdAt is when the call started. */
export function htmlRenderSightings(turnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  return turnItems.flatMap(({ item }) => {
    if (item.type !== "dynamic_tool" || item.status !== "completed") return [];
    const htmlRender = htmlRenderFromToolItem(item);
    if (htmlRender === undefined) return [];
    const visibleAt = DateTime.toEpochMillis(item.completedAt ?? item.updatedAt);
    return [
      { attachmentId: htmlRender.attachmentId, visibleAt, title: htmlRender.title, htmlRender },
    ];
  });
}

/**
 * The page that belongs to a question: the newest render whose title is the
 * question's header, or starts with it followed by a space. "Q1" therefore
 * never claims "Q10 ...".
 */
export function questionHtmlRender(
  renders: ReadonlyArray<HtmlRenderSighting & { readonly htmlRender: HtmlRenderReference }>,
  header: string,
): HtmlRenderReference | null {
  if (header.length === 0) return null;
  let match: (typeof renders)[number] | null = null;
  for (const render of renders) {
    const { title } = render.htmlRender;
    if (title !== header && !title.startsWith(`${header} `)) continue;
    if (match === null || render.visibleAt >= match.visibleAt) match = render;
  }
  return match?.htmlRender ?? null;
}

export interface HtmlRenderAutoOpenState {
  readonly threadKey: string;
  /** When the user started viewing the thread, in epoch milliseconds. */
  readonly viewedSince: number;
  readonly seen: ReadonlySet<string>;
}

/**
 * Decides which render, if any, to open in the panel as the viewed thread's
 * renders change. A thread's first sighting opens nothing, and neither does a
 * render that appeared before the user started viewing it: history, an older
 * page, or what a returning thread's catch-up replays. A call still running
 * when the user arrived counts from its completion, so it opens. Each render
 * opens at most once, and the newest of a batch wins. A question page
 * (`isQuestionPageTitle`) is marked seen but never opened here, so a round's
 * pages publish in the background; when one is the newest of a batch, the
 * batch opens nothing.
 */
export function nextHtmlRenderAutoOpen(
  previous: HtmlRenderAutoOpenState | null,
  input: {
    readonly threadKey: string | null;
    // False while the panel only opens as a sheet: renders are marked seen, never opened.
    readonly enabled: boolean;
    readonly now: number;
    readonly renders: ReadonlyArray<HtmlRenderSighting>;
  },
): { readonly state: HtmlRenderAutoOpenState | null; readonly openAttachmentId: string | null } {
  const { threadKey, renders } = input;
  if (threadKey === null) return { state: null, openAttachmentId: null };
  const ids = renders.map((render) => render.attachmentId);
  if (previous === null || previous.threadKey !== threadKey) {
    return {
      state: { threadKey, viewedSince: input.now, seen: new Set(ids) },
      openAttachmentId: null,
    };
  }
  let open: HtmlRenderSighting | null = null;
  for (const render of input.enabled ? renders : []) {
    if (previous.seen.has(render.attachmentId)) continue;
    if (!(render.visibleAt >= previous.viewedSince)) continue;
    if (open === null || render.visibleAt >= open.visibleAt) open = render;
  }
  if (open !== null && isQuestionPageTitle(open.title)) open = null;
  const grew = ids.some((id) => !previous.seen.has(id));
  return {
    state: grew ? { ...previous, seen: new Set([...previous.seen, ...ids]) } : previous,
    openAttachmentId: open?.attachmentId ?? null,
  };
}

export interface QuestionHtmlRenderOpenState {
  readonly threadKey: string;
  /** The active question's request and matched page, or null without one. */
  readonly target: string | null;
}

/**
 * Decides whether the page for the question on screen opens. Like the
 * newest-first rule, a thread's first sighting (switching in, returning to a
 * round) opens nothing, and a target that changes while the panel is
 * unavailable is recorded without opening, so a later resize opens nothing.
 * Within the viewed thread, a new target opens: a request arriving live, Next
 * or Previous, or a newer page for the same question.
 */
export function nextQuestionHtmlRenderOpen(
  previous: QuestionHtmlRenderOpenState | null,
  input: {
    readonly threadKey: string | null;
    readonly enabled: boolean;
    readonly target: string | null;
  },
): { readonly state: QuestionHtmlRenderOpenState | null; readonly open: boolean } {
  const { threadKey, target } = input;
  if (threadKey === null) return { state: null, open: false };
  if (previous === null || previous.threadKey !== threadKey) {
    return { state: { threadKey, target }, open: false };
  }
  if (previous.target === target) return { state: previous, open: false };
  return { state: { threadKey, target }, open: input.enabled && target !== null };
}

/**
 * Opens each new render in the viewed thread's right panel once. While the
 * panel is unavailable (`enabled` false) renders are still marked seen, so a
 * later resize does not open old pages. While a question round is pending and
 * a page is titled for the question on screen, that page owns the panel: new
 * renders are only marked seen, and Next or Previous re-targets it.
 */
export function useAutoOpenHtmlRenders(input: {
  readonly threadKey: string | null;
  readonly enabled: boolean;
  readonly turnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly open: (attachment: ChatFileAttachment) => void;
  readonly pendingUserInput: PendingUserInput | null;
  readonly questionIndex: number;
}) {
  const { threadKey, enabled, turnItems, open, pendingUserInput, questionIndex } = input;
  const renders = useMemo(() => htmlRenderSightings(turnItems), [turnItems]);
  const requestId = pendingUserInput?.requestId ?? null;
  const header = pendingUserInput?.questions[questionIndex]?.header ?? null;
  const questionRender = useMemo(
    () => (header === null ? null : questionHtmlRender(renders, header)),
    [header, renders],
  );
  const questionAttachmentId = questionRender?.attachmentId ?? null;
  const questionTitle = questionRender?.title ?? null;
  const questionTarget =
    requestId === null || questionAttachmentId === null
      ? null
      : JSON.stringify([requestId, questionAttachmentId]);

  const stateRef = useRef<HtmlRenderAutoOpenState | null>(null);
  useEffect(() => {
    const next = nextHtmlRenderAutoOpen(stateRef.current, {
      threadKey,
      enabled: enabled && questionTarget === null,
      now: Date.now(),
      renders,
    });
    stateRef.current = next.state;
    if (next.openAttachmentId === null) return;
    const render = renders.find((entry) => entry.attachmentId === next.openAttachmentId);
    if (render) open(htmlRenderAttachment(render.htmlRender));
  }, [enabled, open, questionTarget, renders, threadKey]);

  const questionStateRef = useRef<QuestionHtmlRenderOpenState | null>(null);
  useEffect(() => {
    const next = nextQuestionHtmlRenderOpen(questionStateRef.current, {
      threadKey,
      enabled,
      target: questionTarget,
    });
    questionStateRef.current = next.state;
    if (!next.open || questionAttachmentId === null || questionTitle === null) return;
    open(htmlRenderAttachment({ attachmentId: questionAttachmentId, title: questionTitle }));
  }, [enabled, open, questionAttachmentId, questionTarget, questionTitle, threadKey]);
}
