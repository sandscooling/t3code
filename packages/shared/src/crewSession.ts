/**
 * Fork: a thread session_spawn started (`spawnedByThreadId`) is a crew session: stopped means
 * idle, waiting on its orchestrator or a settle, so it reads Idle and its completions stay quiet.
 * A spawned orchestrator is told apart by its exact title "Orchestrator" (the sidebar color rule),
 * so a retired "Orchestrator-<date>" still counts as crew.
 */

import { backgroundWorkTaskHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

const ORCHESTRATOR_TITLE = "Orchestrator";

interface CrewSessionThread {
  /** Absent on v2-created threads, null on some imported ones. */
  readonly spawnedByThreadId?: string | null | undefined;
  /** Every caller passes it; optional only for status inputs that predate the rule. */
  readonly title?: string | undefined;
}

export function isCrewSession(thread: CrewSessionThread): boolean {
  return thread.spawnedByThreadId != null && thread.title !== ORCHESTRATOR_TITLE;
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

type BackgroundWorkHoldTask = Parameters<typeof backgroundWorkTaskHoldsCompletion>[0];

/**
 * Elsewhere a command or monitor holds only when awaited or held, so a dev server left running
 * does not. A crew session resumes when any of its commands or monitors ends, and settling it
 * stops them, so every running one holds it.
 */
export function backgroundWorkTaskHoldsThread(
  thread: CrewSessionThread,
  task: BackgroundWorkHoldTask,
): boolean {
  return (
    backgroundWorkTaskHoldsCompletion(task) ||
    ((task.kind === "command" || task.kind === "monitor") && isCrewSession(thread))
  );
}

export function backgroundWorkHoldsThread(
  thread: CrewSessionThread,
  tasks: ReadonlyArray<BackgroundWorkHoldTask>,
): boolean {
  return tasks.some((task) => backgroundWorkTaskHoldsThread(thread, task));
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
