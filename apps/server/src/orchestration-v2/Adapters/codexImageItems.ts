import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexDynamicToolItem } from "./CodexAdapterV2.ts";

/**
 * Fork: the tool name a Codex viewed image is recorded under. The web work log
 * keeps any row carrying a viewedImagePath on screen.
 */
const CODEX_IMAGE_VIEW_TOOL_NAME = "view_image";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

type NodeUpdatedEvent = Extract<ProviderAdapterV2Event, { readonly type: "node.updated" }>;
type TurnItemUpdatedEvent = Extract<ProviderAdapterV2Event, { readonly type: "turn_item.updated" }>;

interface DynamicToolArtifacts {
  readonly node: NodeUpdatedEvent["node"];
  readonly turnItem: TurnItemUpdatedEvent["turnItem"];
}

function trimText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Fork: turns a completed Codex imageView item into a dynamic_tool work-log row's two events
 * carrying viewedImagePath, since v2 otherwise drops it. Null for any other item, so the adapter
 * carries on; an empty list for an imageView with no path.
 */
export const codexImageItemEvents = <E, R>(
  item: CodexSchema.V2ItemCompletedNotification__ThreadItem,
  buildDynamicToolArtifacts: (
    item: CodexDynamicToolItem,
  ) => Effect.Effect<DynamicToolArtifacts, E, R>,
): Effect.Effect<ReadonlyArray<ProviderAdapterV2Event> | null, E, R> => {
  if (item.type !== "imageView") {
    return Effect.succeed(null);
  }
  const path = trimText(item.path);
  if (path === undefined) {
    return Effect.succeed([]);
  }
  const toolItem: CodexDynamicToolItem = {
    type: "dynamicToolCall",
    id: item.id,
    tool: CODEX_IMAGE_VIEW_TOOL_NAME,
    arguments: { path },
    status: "completed",
  };
  return buildDynamicToolArtifacts(toolItem).pipe(
    Effect.map((artifacts): ReadonlyArray<ProviderAdapterV2Event> => [
      { type: "node.updated", driver: CODEX_PROVIDER, node: artifacts.node },
      {
        type: "turn_item.updated",
        driver: CODEX_PROVIDER,
        turnItem:
          artifacts.turnItem.type === "dynamic_tool"
            ? { ...artifacts.turnItem, title: "Viewed image", viewedImagePath: path }
            : artifacts.turnItem,
      },
    ]),
  );
};
