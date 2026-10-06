// Fork: keeps every thread's preview sessions current, not only the routed
// thread's. usePreviewSession feeds previewStateStore for the routed thread
// alone, so without this a background thread's tabs never reach the sidebar
// globe or SettledPreviewReaper, and a tab closed while you are elsewhere
// stays in the store.
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewListInput,
  type PreviewListResult,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";

/**
 * Applies one event from an environment-wide preview subscription to its own
 * thread. An event from another server epoch means the server restarted and
 * the store would reject it, so that thread is listed again instead.
 */
export function applyEnvironmentPreviewEvent(
  environmentId: EnvironmentId,
  event: PreviewEvent,
  relist: (threadRef: ScopedThreadRef) => void,
): void {
  const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
  const { serverEpoch } = readThreadPreviewState(threadRef);
  if (serverEpoch !== null && serverEpoch !== event.serverEpoch) {
    relist(threadRef);
    return;
  }
  applyPreviewServerEvent(threadRef, event);
}

/** Lists one thread's sessions again and adopts the result; a failed list changes nothing. */
export async function relistPreviewThread<E>(
  threadRef: ScopedThreadRef,
  list: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PreviewListInput;
  }) => Promise<AtomCommandResult<PreviewListResult, E>>,
): Promise<void> {
  const result = await list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  if (result._tag === "Success") reconcilePreviewServerSessions(threadRef, result.value);
}

/** The threads of one environment among the given scoped thread keys. */
export function previewThreadRefsIn(
  environmentId: EnvironmentId,
  threadKeys: Iterable<string>,
): ScopedThreadRef[] {
  const refs: ScopedThreadRef[] = [];
  for (const threadKey of threadKeys) {
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef?.environmentId === environmentId) refs.push(threadRef);
  }
  return refs;
}
