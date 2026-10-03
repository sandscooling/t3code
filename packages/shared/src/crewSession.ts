/**
 * Fork: crew sessions. A thread another session spawned (session_spawn sets
 * `spawnedByThreadId`) is a crew session. When it stops it is not done in the
 * user's sense: it is idle, waiting for its orchestrator, a peer, or to be
 * settled. Clients label it Idle and its finished-turn alerts stay quiet.
 *
 * Orchestrators are not crew sessions: a handoff successor inherits its
 * predecessor's spawner, which is null for a top-level orchestrator.
 */

interface CrewSessionThread {
  /** Absent on v2-created threads, null on some imported ones. */
  readonly spawnedByThreadId?: string | null | undefined;
}

export function isCrewSession(thread: CrewSessionThread): boolean {
  return thread.spawnedByThreadId != null;
}

/**
 * Whether a client should label the thread Idle. `status` is the client's
 * resolved thread status; only "ready" (between turns, with nothing such as
 * Waiting, Approval, Input, Limited or Failed outranking it) becomes Idle.
 * A settled crew session leaves the active list, so it never reads Idle.
 */
export function isIdleCrewSession(
  thread: CrewSessionThread & {
    readonly settledOverride?: "settled" | "active" | null | undefined;
  },
  status: string,
): boolean {
  return status === "ready" && isCrewSession(thread) && thread.settledOverride !== "settled";
}

export type ThreadAlertKind = "completion" | "failure" | "input" | "approval";

/**
 * Whether an alert (sound, desktop popup, mobile push) is silenced. Only a
 * crew session's completed turn is: a failure, question or approval still
 * needs the user.
 */
export function isSilencedCrewAlert(thread: CrewSessionThread, kind: ThreadAlertKind): boolean {
  return kind === "completion" && isCrewSession(thread);
}
