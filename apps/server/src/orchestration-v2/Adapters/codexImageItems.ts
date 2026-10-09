import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as CodexSchema from "effect-codex-app-server/schema";

import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexDynamicToolItem } from "./CodexAdapterV2.ts";

/**
 * Fork: the tool names a Codex generated or viewed image is recorded under. The
 * web work log keeps any row carrying a viewedImagePath on screen.
 */
const CODEX_IMAGE_GENERATION_TOOL_NAME = "image_generation";
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
 * Fork: turns a completed Codex imageGeneration or imageView item into the two
 * events of a dynamic_tool work-log row carrying the image as viewedImagePath.
 * v2 otherwise drops these items; v1 read the same paths. Returns null for any
 * other item so the adapter carries on, and an empty list for an image item
 * with no path.
 */
export const codexImageItemEvents = <E, R>(
  item: CodexSchema.V2ItemCompletedNotification__ThreadItem,
  buildDynamicToolArtifacts: (
    item: CodexDynamicToolItem,
  ) => Effect.Effect<DynamicToolArtifacts, E, R>,
): Effect.Effect<ReadonlyArray<ProviderAdapterV2Event> | null, E, R> => {
  let toolItem: CodexDynamicToolItem;
  let title: string;
  let viewedImagePath: string;
  if (item.type === "imageGeneration") {
    const savedPath = trimText(item.savedPath);
    if (savedPath === undefined) {
      return Effect.succeed([]);
    }
    const revisedPrompt = trimText(item.revisedPrompt);
    toolItem = {
      type: "dynamicToolCall",
      id: item.id,
      tool: CODEX_IMAGE_GENERATION_TOOL_NAME,
      arguments: revisedPrompt === undefined ? {} : { prompt: revisedPrompt },
      status: "completed",
    };
    title = "Generated image";
    viewedImagePath = savedPath;
  } else if (item.type === "imageView") {
    const path = trimText(item.path);
    if (path === undefined) {
      return Effect.succeed([]);
    }
    toolItem = {
      type: "dynamicToolCall",
      id: item.id,
      tool: CODEX_IMAGE_VIEW_TOOL_NAME,
      arguments: { path },
      status: "completed",
    };
    title = "Viewed image";
    viewedImagePath = path;
  } else {
    return Effect.succeed(null);
  }
  return buildDynamicToolArtifacts(toolItem).pipe(
    Effect.map((artifacts): ReadonlyArray<ProviderAdapterV2Event> => [
      { type: "node.updated", driver: CODEX_PROVIDER, node: artifacts.node },
      {
        type: "turn_item.updated",
        driver: CODEX_PROVIDER,
        turnItem:
          artifacts.turnItem.type === "dynamic_tool"
            ? { ...artifacts.turnItem, title, viewedImagePath }
            : artifacts.turnItem,
      },
    ]),
  );
};
