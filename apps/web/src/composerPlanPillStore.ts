import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Expanded/collapsed state for the composer plan pill, one entry per thread.
 *
 * Deliberately in-memory: the pill is collapsed by default and unfolding it is
 * a "show me the rest of this list" gesture, not a preference worth carrying
 * across restarts. Staying out of localStorage also means no stored key to
 * version and no per-thread entry to reap when a thread is deleted.
 */
interface ComposerPlanPillStoreState {
  expandedByThreadKey: Record<string, boolean>;
  togglePlanPill: (ref: ScopedThreadRef) => void;
}

export const useComposerPlanPillStore = create<ComposerPlanPillStoreState>()((set) => ({
  expandedByThreadKey: {},
  togglePlanPill: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      return {
        expandedByThreadKey: {
          ...state.expandedByThreadKey,
          [threadKey]: !state.expandedByThreadKey[threadKey],
        },
      };
    }),
}));

export function selectPlanPillExpanded(
  expandedByThreadKey: Record<string, boolean>,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  if (!ref) {
    return false;
  }
  return expandedByThreadKey[scopedThreadKey(ref)] ?? false;
}
