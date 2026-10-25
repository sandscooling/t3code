/**
 * Fork: Electron draws no frames for an offscreen `<webview>`, stalling a background agent's
 * screenshots and input (pingdotgg/t3code#16567). While the server holds the tab, the wrapper
 * peeks as a 1x1 px, 1% opacity click-through corner, the webview full-size inside it, and the
 * desktop unthrottles the guest (automationDrawing.fork.ts). Behind-the-app is unreliable on Windows.
 */
import { useEffect } from "react";
import { create } from "zustand";

import type { HostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

interface AgentDrawingState {
  /** Server tabs the server holds drawing, by thread and tab. */
  readonly drawing: Readonly<Record<string, true>>;
  readonly apply: (event: {
    readonly threadId: string;
    readonly tabId: string;
    readonly active: boolean;
  }) => void;
}

export const useAgentDrawingStore = create<AgentDrawingState>()((set) => ({
  drawing: {},
  apply: ({ threadId, tabId, active }) =>
    set((state) => {
      const key = keyOf(threadId, tabId);
      if ((state.drawing[key] === true) === active) return state;
      const drawing = { ...state.drawing };
      if (active) drawing[key] = true;
      else delete drawing[key];
      return { drawing };
    }),
}));

/** Listens for the desktop's drawing switches. Mounted once, by the host of every webview. */
export function useAgentDrawingEvents() {
  useEffect(
    () =>
      window.desktopBridge?.preview?.onAutomationDrawing?.((event) =>
        useAgentDrawingStore.getState().apply(event),
      ),
    [],
  );
}

/** Whether the server holds this tab drawing; only its own server's tabs can be. */
export const useAgentDrawing = (threadId: string, tabId: string, serverDriven: boolean) =>
  useAgentDrawingStore((state) => serverDriven && state.drawing[keyOf(threadId, tabId)] === true);

/** Above anything the app draws; the sliver is click-through and nearly transparent. */
export const AGENT_DRAWING_Z_INDEX = 2_147_483_647;

export type AgentDrawingWrapperStyle = HostedBrowserWebviewWrapperStyle & {
  readonly opacity?: number;
};

/**
 * Peeks a tab the agent acts on when it would otherwise be parked. A tab that
 * is shown, recorded, or in picture-in-picture already renders, so it keeps
 * its placement; and off, the tab is exactly where it was.
 */
export function withAgentDrawingPlacement(
  style: HostedBrowserWebviewWrapperStyle,
  input: { readonly agentDrawing: boolean; readonly renderingActive: boolean },
): AgentDrawingWrapperStyle {
  if (!input.agentDrawing || input.renderingActive) return style;
  return {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    zIndex: AGENT_DRAWING_Z_INDEX,
    pointerEvents: "none",
    visibility: "visible",
    opacity: 0.01,
  };
}
