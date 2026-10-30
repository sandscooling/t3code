// Fork-owned: an agent's HTML render shown inline, or as a card that opens it in the right panel.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { AppWindowIcon } from "lucide-react";
import { useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import type { ChatFileAttachment } from "~/types";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { htmlRenderAttachment, isQuestionPageTitle } from "./htmlRenderPanel.fork";

/**
 * A page shows inline with Open and Collapse; a question page starts as the
 * compact card, marked while it is the panel's active tab. Where the right
 * panel only opens as a sheet over the chat, every page stays inline as
 * upstream shows it.
 */
export function HtmlRenderPanelCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly htmlRender: HtmlRenderReference;
  readonly onOpen: (attachment: ChatFileAttachment) => void;
  readonly onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const sheetLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const surfaceId = `attachment:${props.htmlRender.attachmentId}`;
  // A boolean selector, so a card re-renders only when its own state flips.
  const shownInPanel = useRightPanelStore(
    (state) => selectActiveRightPanelSurface(state.byThreadKey, props.threadRef)?.id === surfaceId,
  );

  const [inline, setInline] = useState(() => !isQuestionPageTitle(props.htmlRender.title));
  const open = () => props.onOpen(htmlRenderAttachment(props.htmlRender));

  const frame = (
    <HtmlRenderFrame
      environmentId={props.environmentId}
      htmlRender={props.htmlRender}
      threadRef={props.threadRef ?? undefined}
      onFullscreenChange={props.onFullscreenChange}
    />
  );
  if (sheetLayout || props.threadRef === null) return frame;
  if (inline) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5 px-1">
          <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">{props.htmlRender.title}</span>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Collapse ${props.htmlRender.title}`}
            onClick={() => setInline(false)}
          >
            Collapse
          </Button>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Open ${props.htmlRender.title} in panel`}
            onClick={open}
          >
            Open
          </Button>
        </div>
        {frame}
      </div>
    );
  }

  return (
    // The whole card reopens the page; the button is its keyboard target.
    <div
      className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/70 bg-background/70 px-3 py-2 hover:bg-accent/40"
      onClick={open}
    >
      <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
          {props.htmlRender.title}
        </TooltipTrigger>
        <TooltipPopup side="top">{props.htmlRender.title}</TooltipPopup>
      </Tooltip>
      {shownInPanel ? (
        <Badge variant="info" size="sm">
          In panel
        </Badge>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Show ${props.htmlRender.title} inline`}
        onClick={(event) => {
          event.stopPropagation();
          setInline(true);
        }}
      >
        Inline
      </Button>
      <Button
        size="xs"
        variant="outline"
        aria-label={`Open ${props.htmlRender.title} in panel`}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
      >
        Open
      </Button>
    </div>
  );
}
