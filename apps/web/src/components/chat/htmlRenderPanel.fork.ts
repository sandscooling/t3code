// Fork-owned: question-round HTML pages open in the right panel as their question comes up.
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { htmlRenderFileName, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { DateTime } from "effect";
import { useEffect, useRef } from "react";

import type { PendingUserInput } from "~/session-logic";
import type { ChatFileAttachment } from "~/types";

/** The panel attachment for a render, the shape the file preview panel reads. */
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

/**
 * Whether a render title names a question round's page: "Q", digits, then a
 * space or the end ("Q1", "Q12 Where the page sits"). Such pages open in the
 * panel when their question is on screen; every other page shows inline.
 */
export function isQuestionPageTitle(title: string): boolean {
  return /^Q\d+(?: |$)/.test(title);
}

/** The thread's completed html_render pages, timed by completion: a row's createdAt is when the call started. */
export function htmlRenderSightings(turnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>) {
  return turnItems.flatMap(({ item }) => {
    if (item.type !== "dynamic_tool" || item.status !== "completed") return [];
    const htmlRender = htmlRenderFromToolItem(item);
    if (htmlRender === undefined) return [];
    const visibleAt = DateTime.toEpochMillis(item.completedAt ?? item.updatedAt);
    return [{ visibleAt, htmlRender }];
  });
}

/**
 * The page that belongs to a question: the newest question page whose title is
 * the question's header, or starts with it followed by a space. "Q1" therefore
 * never claims "Q10 ...".
 */
export function questionHtmlRender(
  renders: ReadonlyArray<{
    /** When the `html_render` call completed and the page appeared, in epoch milliseconds. */
    readonly visibleAt: number;
    readonly htmlRender: HtmlRenderReference;
  }>,
  header: string,
): HtmlRenderReference | null {
  if (header.length === 0) return null;
  let match: (typeof renders)[number] | null = null;
  for (const render of renders) {
    const { title } = render.htmlRender;
    if (!isQuestionPageTitle(title)) continue;
    if (title !== header && !title.startsWith(`${header} `)) continue;
    if (match === null || render.visibleAt >= match.visibleAt) match = render;
  }
  return match?.htmlRender ?? null;
}

export interface QuestionHtmlRenderOpenState {
  readonly threadKey: string;
  /** The active question's request and matched page, or null without one. */
  readonly target: string | null;
}

/**
 * Whether the on-screen question's page opens. A thread's first sighting opens nothing, and a
 * target changing while the panel is unavailable is recorded unopened, so a later resize opens
 * nothing. Within the viewed thread a new target opens: a live request, Next or Previous, or a
 * newer page for the same question.
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

/** Opens the on-screen question's page in the viewed thread's right panel, once per target. */
export function useAutoOpenQuestionHtmlRender(input: {
  readonly threadKey: string | null;
  readonly enabled: boolean;
  readonly turnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>;
  readonly open: (attachment: ChatFileAttachment) => void;
  readonly pendingUserInput: PendingUserInput | null;
  readonly questionIndex: number;
}) {
  const { threadKey, enabled, turnItems, open, pendingUserInput, questionIndex } = input;
  const renders = htmlRenderSightings(turnItems);
  const requestId = pendingUserInput?.requestId ?? null;
  const header = pendingUserInput?.questions[questionIndex]?.header ?? null;
  const questionRender = header === null ? null : questionHtmlRender(renders, header);
  const questionAttachmentId = questionRender?.attachmentId ?? null;
  const questionTitle = questionRender?.title ?? null;
  const questionTarget =
    requestId === null || questionAttachmentId === null
      ? null
      : JSON.stringify([requestId, questionAttachmentId]);

  const questionStateRef = useRef<QuestionHtmlRenderOpenState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fork: open the HTML render a pending question points at, once per question.
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
