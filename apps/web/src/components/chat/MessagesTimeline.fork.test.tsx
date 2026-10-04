// Fork-owned tests for MessagesTimeline.test.tsx.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

// Only workspace media resolves here. Attachment resources keep the real
// pending behaviour so the optimistic-upload rows still assert against it.
const assetUrlMocks = vi.hoisted(() => ({
  useAssetUrlState: vi.fn((_environmentId: unknown, resource: { _tag?: string } | null) =>
    resource?._tag === "media-file"
      ? {
          _tag: "Success" as const,
          url: "https://environment.test/api/assets/signed-token/result.png",
        }
      : { _tag: "Loading" as const },
  ),
  useAssetUrlRefresh: vi.fn(() => async () => {}),
  // Upstream batches message previews through this; the rows under test read
  // their URLs from useAssetUrlState, so an empty list is the honest answer.
  useAssetUrls: vi.fn((_environmentId: unknown, resources: ReadonlyArray<unknown>) =>
    resources.map(() => null),
  ),
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: assetUrlMocks.useAssetUrlState,
  useAssetUrlRefresh: assetUrlMocks.useAssetUrlRefresh,
  useAssetUrls: assetUrlMocks.useAssetUrls,
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;

const ElementStub = class ElementStub {};
function stubDomGlobals() {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("Element", ElementStub);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    Element: ElementStub,
    localStorage: globalThis.localStorage,
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
}

beforeEach(stubDomGlobals);
beforeAll(async () => {
  stubDomGlobals();
  ({ MessagesTimeline } = await import("./MessagesTimeline"));
}, 30_000);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    providerStatuses: [],
    runs: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

describe("MessagesTimeline", () => {
  // Fork: a generated image renders inline, without expanding its row.
  it("renders a generated image's Windows path inline after Markdown URL sanitization", () => {
    const imagePath = "C:\\Users\\mike\\dev-stuff\\t3code\\result.png";
    assetUrlMocks.useAssetUrlState.mockClear();

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          // Upstream #7152 folds a tool-only group behind a "+N tool calls"
          // toggle, and only the last entry of a group stays visible. A
          // non-tool entry ahead of the image view is what a real work log
          // looks like when the image is the newest row, and it is the shape
          // that renders the row inline rather than collapsed.
          {
            id: "entry-context",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-context",
              createdAt: MESSAGE_CREATED_AT,
              label: "Context compacted",
              tone: "info",
            },
          },
          {
            id: "entry-image-view",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-image-view",
              createdAt: MESSAGE_CREATED_AT,
              label: "Generated image",
              tone: "tool",
              itemType: "dynamic_tool",
              viewedImagePath: imagePath,
              structuredPayload: { type: "dynamic_tool", toolName: "image_generation" } as never,
            },
          },
        ]}
        workspaceRoot="C:\\Users\\mike\\dev-stuff\\t3code"
      />,
    );

    expect(assetUrlMocks.useAssetUrlState).toHaveBeenCalledWith(ACTIVE_THREAD_ENVIRONMENT_ID, {
      _tag: "media-file",
      threadId: ThreadId.make("thread-1"),
      path: imagePath,
    });
    expect(markup).toContain('src="https://environment.test/api/assets/signed-token/result.png"');
  });
});
