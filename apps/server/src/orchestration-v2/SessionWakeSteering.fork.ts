/**
 * Fork-owned: whether a message one agent sends another session (session_wake, and the failure
 * notice back to its sender) joins the target's running turn or queues behind it. It joins only
 * where the provider's steer waits for the running tool instead of cancelling it, so the target
 * keeps its work and reads the message at its next step. Anything else queues, as before.
 */
import { ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import type {
  ThreadManagementSendInput,
  ThreadManagementServiceShape,
} from "./ThreadManagementService.ts";

// Claude steers an agent's message at priority "next"; Codex turn/steer and Kiro _session/steer
// wait for the tool. Pi's steer skips the turn's remaining tools, Cursor and ACP restart the turn,
// and Muse and OpenCode are unverified, so those queue.
const STEERS_WITHOUT_CANCELLING: ReadonlySet<ProviderDriverKind> = new Set(
  ["claudeAgent", "codex", "kiro"].map((driver) => ProviderDriverKind.make(driver)),
);

/**
 * "auto" steers into the target's running turn; "queue" waits behind it, or starts one on an idle
 * target. A question or approval the target has open, a message already waiting in its queue
 * (held or not, so a wake never overtakes one), a Stop on its way, or a model or provider change
 * since the turn started (the orchestrator would restart the turn to apply it) all queue.
 */
export const agentMessageMode = Effect.fn("SessionWakeSteering.agentMessageMode")(function* (
  threads: Pick<ThreadManagementServiceShape, "getThreadRecords">,
  target: { readonly id: ThreadId; readonly pendingRuntimeRequest: unknown },
) {
  if (target.pendingRuntimeRequest !== null) return "queue" as const;
  const { thread, runs } = yield* threads.getThreadRecords(target.id, ["runs"], {
    runStatuses: ["queued", "running"],
  });
  const active = runs.findLast((run) => run.status === "running");
  if (
    active === undefined ||
    runs.some((run) => run.status === "queued") ||
    !modelSelectionsEqual(thread.modelSelection, active.modelSelection)
  )
    return "queue" as const;
  const records = yield* threads.getThreadRecords(
    target.id,
    ["providerThreads", "providerTurns", "turnItems"],
    {
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [active.id],
      ...(active.activeAttemptId === null
        ? {}
        : { providerTurnAttemptIds: [active.activeAttemptId] }),
    },
  );
  const driver = records.providerThreads.find(
    (thread) => thread.id === active.providerThreadId,
  )?.driver;
  const turnRunning = records.providerTurns.some(
    (turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running",
  );
  return driver !== undefined &&
    STEERS_WITHOUT_CANCELLING.has(driver) &&
    turnRunning &&
    records.turnItems.length === 0
    ? ("auto" as const)
    : ("queue" as const);
});

/**
 * Sends in agentMessageMode. A steer the orchestrator refuses (the provider session went away
 * between the check and the dispatch, say) queues instead, under the retry's own command id,
 * since the refused one keeps its rejected receipt.
 */
export const sendAgentMessage = Effect.fn("SessionWakeSteering.sendAgentMessage")(function* (
  threads: Pick<ThreadManagementServiceShape, "getThreadRecords" | "sendToThread">,
  target: { readonly id: ThreadId; readonly pendingRuntimeRequest: unknown },
  message: (input: {
    readonly mode: "auto" | "queue";
    readonly retry: boolean;
  }) => Effect.Effect<ThreadManagementSendInput>,
) {
  const mode = yield* agentMessageMode(threads, target);
  const first = yield* message({ mode, retry: false });
  if (mode === "queue") return yield* threads.sendToThread(first);
  return yield* threads.sendToThread(first).pipe(
    Effect.catchTags({
      OrchestratorDispatchError: (refused) =>
        Effect.logInfo("orchestration-v2.session-wake-steer-refused", {
          threadId: target.id,
          cause: refused.cause,
        }).pipe(
          Effect.andThen(message({ mode: "queue", retry: true })),
          Effect.flatMap(threads.sendToThread),
        ),
    }),
  );
});
