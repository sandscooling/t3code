import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  AGENT_DRAWING_Z_INDEX,
  useAgentDrawingStore,
  withAgentDrawingPlacement,
} from "./agentDrawing.fork";
import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

const hiddenSize = { width: 1280, height: 800 };
const parked = resolveHostedBrowserWebviewWrapperStyle({
  active: false,
  renderingActive: false,
  rect: null,
  hiddenSize,
});
const behind = resolveHostedBrowserWebviewWrapperStyle({
  active: false,
  renderingActive: true,
  rect: null,
  hiddenSize,
});

describe("withAgentDrawingPlacement", () => {
  it("peeks a parked tab the agent acts on: one click-through, nearly clear pixel above the app", () => {
    expect(parked.left).toBe(HIDDEN_BROWSER_WEBVIEW_OFFSET);
    expect(
      withAgentDrawingPlacement(parked, { agentDrawing: true, renderingActive: false }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      zIndex: AGENT_DRAWING_Z_INDEX,
      pointerEvents: "none",
      visibility: "visible",
      opacity: 0.01,
    });
  });

  it("leaves a tab exactly where it was when no agent acts on it", () => {
    expect(withAgentDrawingPlacement(parked, { agentDrawing: false, renderingActive: false })).toBe(
      parked,
    );
  });

  it("keeps a shown, recorded or picture-in-picture tab's own placement", () => {
    expect(withAgentDrawingPlacement(behind, { agentDrawing: true, renderingActive: true })).toBe(
      behind,
    );
  });
});

describe("useAgentDrawingStore", () => {
  beforeEach(() => {
    useAgentDrawingStore.setState({ drawing: {} });
  });

  it("tracks each server tab's switch, keyed by thread and tab", () => {
    const { apply } = useAgentDrawingStore.getState();
    apply({ threadId: "thread-1", tabId: "tab-1", active: true });
    apply({ threadId: "thread-2", tabId: "tab-1", active: true });
    apply({ threadId: "thread-1", tabId: "tab-1", active: false });
    expect(Object.keys(useAgentDrawingStore.getState().drawing)).toEqual(["thread-2\u0000tab-1"]);
  });

  it("does not notify subscribers for a switch that changes nothing", () => {
    const { apply } = useAgentDrawingStore.getState();
    const before = useAgentDrawingStore.getState();
    apply({ threadId: "thread-1", tabId: "tab-1", active: false });
    expect(useAgentDrawingStore.getState()).toBe(before);
  });
});
