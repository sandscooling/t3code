// Fork-owned: an agent's HTML render as a card that opens the page in the right panel.
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { AppWindowIcon } from "lucide-react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import type { ChatFileAttachment } from "~/types";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { htmlRenderAttachment } from "./htmlRenderPanel.fork";

/**
 * A compact card for the page, marked while it is the panel's active tab.
 * Where the right panel only opens as a sheet over the chat, the page stays
 * inline as upstream shows it.
 */
export function HtmlRenderPanelCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly htmlRender: HtmlRenderReference;
  readonly onOpen: (attachment: ChatFileAttachment) => void;
}) {
  const sheetLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const surfaceId = `attachment:${props.htmlRender.attachmentId}`;
  // A boolean selector, so a card re-renders only when its own state flips.
  const shownInPanel = useRightPanelStore(
    (state) => selectActiveRightPanelSurface(state.byThreadKey, props.threadRef)?.id === surfaceId,
  );

  if (sheetLayout || props.threadRef === null) {
    return (
      <HtmlRenderFrame
        environmentId={props.environmentId}
        htmlRender={props.htmlRender}
        onOpen={props.onOpen}
      />
    );
  }

  const open = () => props.onOpen(htmlRenderAttachment(props.htmlRender));
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
