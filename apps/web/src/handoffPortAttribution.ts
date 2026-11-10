/**
 * Fork-owned: a handoff successor's Servers panel also lists the servers its predecessors'
 * agents started (by T3CODE_THREAD_ID), so a handoff needs no server restart. The successor's
 * own shell names its predecessors, so this holds after the prune deletes their threads.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./state/threads";

const KEY_SEPARATOR = "\n";

type ShellIndex = ReadonlyMap<
  ThreadId,
  Pick<
    OrchestrationV2ThreadShell,
    "successorThreadId" | "handoffPredecessorThreadIds" | "archivedAt" | "deletedAt"
  >
>;

/**
 * The threads that handed off, directly or through others, to `threadId`. A thread that has
 * since handed off to a live thread passes them on with its own.
 */
export function handedOffThreadIds(index: ShellIndex, threadId: ThreadId): ReadonlyArray<ThreadId> {
  const shell = index.get(threadId);
  if (shell === undefined) return [];
  const successor =
    shell.successorThreadId == null ? undefined : index.get(shell.successorThreadId);
  if (successor !== undefined && successor.archivedAt === null && successor.deletedAt === null) {
    return [];
  }
  return shell.handoffPredecessorThreadIds ?? [];
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
