// Fork-owned: agent HTML renders open in the right panel instead of inline.
import { htmlRenderFileName, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { useEffect, useMemo, useRef } from "react";

import type { TimelineEntry } from "~/session-logic";
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
  readonly createdAt: string;
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
 * render created before the user started viewing it: history, an older page,
 * or what a returning thread's catch-up replays. Each render opens at most
 * once, and the newest of a batch wins.
 */
export function nextHtmlRenderAutoOpen(
  previous: HtmlRenderAutoOpenState | null,
  input: {
    readonly threadKey: string | null;
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
  let open: { readonly attachmentId: string; readonly at: number } | null = null;
  for (const render of renders) {
    if (previous.seen.has(render.attachmentId)) continue;
    const at = Date.parse(render.createdAt);
    if (!(at >= previous.viewedSince)) continue;
    if (open === null || at >= open.at) open = { attachmentId: render.attachmentId, at };
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
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly open: (attachment: ChatFileAttachment) => void;
}) {
  const { threadKey, enabled, entries, open } = input;
  const renders = useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.kind === "html-render"
          ? [
              {
                attachmentId: entry.htmlRender.attachmentId,
                createdAt: entry.createdAt,
                htmlRender: entry.htmlRender,
              },
            ]
          : [],
      ),
    [entries],
  );
  const stateRef = useRef<HtmlRenderAutoOpenState | null>(null);
  useEffect(() => {
    const next = nextHtmlRenderAutoOpen(stateRef.current, {
      threadKey,
      now: Date.now(),
      renders,
    });
    stateRef.current = next.state;
    if (!enabled || next.openAttachmentId === null) return;
    const render = renders.find((entry) => entry.attachmentId === next.openAttachmentId);
    if (render) open(htmlRenderAttachment(render.htmlRender));
  }, [enabled, open, renders, threadKey]);
}
