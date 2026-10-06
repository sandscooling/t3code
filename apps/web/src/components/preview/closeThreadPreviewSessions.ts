import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PreviewCloseInput, ScopedThreadRef } from "@t3tools/contracts";

import {
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  readThreadPreviewState,
} from "~/previewStateStore";

interface CloseThreadPreviewSessionsInput<E> {
  readonly closePreview: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewCloseInput;
  }) => Promise<AtomCommandResult<void, E>>;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Closes every preview session on a thread in one request, applying the same
 * optimistic local removal `closePreviewSession` does for a single tab.
 *
 * The sidebar globe and ElectronBrowserHost both read this store, so the local
 * half drops the globe and unmounts a desktop webview at once rather than when
 * the server's "closed" event arrives through PreviewSessionsFeed.
 *
 * A failed close restores every session it removed.
 */
export async function closeThreadPreviewSessions<E>(
  input: CloseThreadPreviewSessionsInput<E>,
): Promise<AtomCommandResult<void, E>> {
  const { threadRef } = input;
  const closing = Object.values(readThreadPreviewState(threadRef).sessions);
  for (const snapshot of closing) {
    beginPreviewSessionClose(threadRef, snapshot.tabId);
  }
  const restore = () => {
    for (const snapshot of closing) {
      cancelPreviewSessionClose(threadRef, snapshot, snapshot.tabId);
    }
  };
  try {
    const result = await input.closePreview({
      environmentId: threadRef.environmentId,
      // No tabId: every session on the thread goes, not just one.
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      restore();
    }
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
