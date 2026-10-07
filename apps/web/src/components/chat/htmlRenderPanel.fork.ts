// Fork-owned: agent HTML renders open in the right panel instead of inline.
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { htmlRenderFileName, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { DateTime } from "effect";
import { useEffect, useMemo, useRef } from "react";

import type { ChatFileAttachment } from "~/types";

/** The panel attachment for a render, the same one the inline frame's "Open in panel" builds. */
export function htmlRenderAttachment(htmlRender: HtmlRenderReference): ChatFileAttachment {
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
 * opens at most once, and the newest of a batch wins.
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
  const grew = ids.some((id) => !previous.seen.has(id));
  return {
    state: grew ? { ...previous, seen: new Set([...previous.seen, ...ids]) } : previous,
    openAttachmentId: open?.attachmentId ?? null,
  };
}

/**
 * Opens each new render in the viewed thread's right panel once. While the
 * panel is unavailable (`enabled` false) renders are still marked seen, so a
 * later resize does not open old pages.
 */
export function useAutoOpenHtmlRenders(input: {
  readonly threadKey: string | null;
  readonly enabled: boolean;
  readonly turnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly open: (attachment: ChatFileAttachment) => void;
}) {
  const { threadKey, enabled, turnItems, open } = input;
  // The timeline's own html-render rows, but timed by completion: a row's
  // createdAt is when the call started.
  const renders = useMemo(
    () =>
      turnItems.flatMap(({ item }) => {
        if (item.type !== "dynamic_tool" || item.status !== "completed") return [];
        const htmlRender = htmlRenderFromToolItem(item);
        if (htmlRender === undefined) return [];
        const visibleAt = DateTime.toEpochMillis(item.completedAt ?? item.updatedAt);
        return [{ attachmentId: htmlRender.attachmentId, visibleAt, htmlRender }];
      }),
    [turnItems],
  );
  const stateRef = useRef<HtmlRenderAutoOpenState | null>(null);
  useEffect(() => {
    const next = nextHtmlRenderAutoOpen(stateRef.current, {
      threadKey,
      enabled,
      now: Date.now(),
      renders,
    });
    stateRef.current = next.state;
    if (next.openAttachmentId === null) return;
    const render = renders.find((entry) => entry.attachmentId === next.openAttachmentId);
    if (render) open(htmlRenderAttachment(render.htmlRender));
  }, [enabled, open, renders, threadKey]);
}
