import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerActivityTab } from "./components/chat/ComposerActivityBar.logic";

/**
 * Expanded/collapsed state and tab selection for the composer activity bar,
 * one entry per thread.
 *
 * Deliberately in-memory: the bar is collapsed by default and unfolding it is
 * a "show me the rest of this list" gesture, not a preference worth carrying
 * across restarts. Staying out of localStorage also means no stored key to
 * version and no per-thread entry to reap when a thread is deleted.
 */
interface ComposerActivityBarStoreState {
  expandedByThreadKey: Record<string, boolean>;
  /** Absent means "follow the default tab", which tracks what is live. */
  tabByThreadKey: Record<string, ComposerActivityTab>;
  toggleActivityBar: (ref: ScopedThreadRef) => void;
  selectActivityTab: (ref: ScopedThreadRef, tab: ComposerActivityTab) => void;
}

export const useComposerActivityBarStore = create<ComposerActivityBarStoreState>()((set) => ({
  expandedByThreadKey: {},
  tabByThreadKey: {},
  toggleActivityBar: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      return {
        expandedByThreadKey: {
          ...state.expandedByThreadKey,
          [threadKey]: !state.expandedByThreadKey[threadKey],
        },
      };
    }),
  // Picking a tab is also how you open the bar from a collapsed badge.
  selectActivityTab: (ref, tab) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      return {
        expandedByThreadKey: { ...state.expandedByThreadKey, [threadKey]: true },
        tabByThreadKey: { ...state.tabByThreadKey, [threadKey]: tab },
      };
    }),
}));

export function selectActivityBarExpanded(
  expandedByThreadKey: Record<string, boolean>,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  if (!ref) {
    return false;
  }
  return expandedByThreadKey[scopedThreadKey(ref)] ?? false;
}

export function selectActivityBarTab(
  tabByThreadKey: Record<string, ComposerActivityTab>,
  ref: ScopedThreadRef | null | undefined,
): ComposerActivityTab | null {
  if (!ref) {
    return null;
  }
  return tabByThreadKey[scopedThreadKey(ref)] ?? null;
}
