/**
 * Fork-owned: a handoff successor's Servers panel also lists the servers its
 * predecessors' agents started, so a handoff needs no server restart to move
 * them. Matching is by the agent's thread (T3CODE_THREAD_ID), which also
 * covers hand-made systemd units that carry it.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  SESSION_SUCCESSOR_MAX_HOPS,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./state/threads";

const KEY_SEPARATOR = "\n";

type SuccessorIndex = ReadonlyMap<
  ThreadId,
  Pick<OrchestrationV2ThreadShell, "successorThreadId" | "archivedAt" | "deletedAt">
>;

/** Where a thread's successor links lead, stopping at a missing, archived or deleted one, or a cycle. */
function successorChainEnd(index: SuccessorIndex, threadId: ThreadId): ThreadId {
  const seen = new Set([threadId]);
  let current = threadId;
  for (let hop = 0; hop < SESSION_SUCCESSOR_MAX_HOPS; hop += 1) {
    const next = index.get(current)?.successorThreadId;
    const successor = next == null ? undefined : index.get(next);
    if (
      next == null ||
      seen.has(next) ||
      successor === undefined ||
      successor.archivedAt !== null ||
      successor.deletedAt !== null
    ) {
      break;
    }
    seen.add(next);
    current = next;
  }
  return current;
}

/** The threads that handed off, directly or through others, to `threadId`. */
export function handedOffThreadIds(index: SuccessorIndex, threadId: ThreadId): Array<ThreadId> {
  const ids: Array<ThreadId> = [];
  for (const [id, shell] of index) {
    if (id !== threadId && shell.successorThreadId != null) {
      if (successorChainEnd(index, id) === threadId) ids.push(id);
    }
  }
  return ids.toSorted();
}

// A string, so a shell change that leaves the set alone does not re-render the panel.
const handedOffKeyAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split(KEY_SEPARATOR) as [EnvironmentId, ThreadId];
  return Atom.make((get) =>
    handedOffThreadIds(
      get(environmentThreadShells.environmentThreadIndexAtom(environmentId)),
      threadId,
    ).join(KEY_SEPARATOR),
  ).pipe(Atom.withLabel(`fork-handed-off-threads:${environmentId}:${threadId}`));
});

const NO_THREADS_ATOM = Atom.make("").pipe(Atom.withLabel("fork-handed-off-threads:none"));

export function useHandedOffThreadIds(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlySet<string> {
  const key = useAtomValue(
    environmentId === null || threadId === null
      ? NO_THREADS_ATOM
      : handedOffKeyAtom(`${environmentId}${KEY_SEPARATOR}${threadId}`),
  );
  return new Set(key.length === 0 ? [] : key.split(KEY_SEPARATOR));
}
