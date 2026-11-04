/**
 * Fork-owned: Claude "next" steers. They wait for the tool boundary instead of cancelling it, a
 * result that leaves one unanswered ends only a segment of the T3 turn, and a Stop withdraws them.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** How long a Stop waits for the CLI to acknowledge a steer still in flight to it. */
const ACK_TIMEOUT_MS = 2_000;

/** A person's steer, or a queued message they promoted to Steer, cuts in; the rest wait. */
export const claudeSteerPriority = (input: {
  readonly createdBy: string;
  readonly cutsIn?: boolean | undefined;
}): "now" | "next" => (input.createdBy === "user" || input.cutsIn === true ? "now" : "next");

export const makeClaudeNextSteers = () => {
  const pendingByTurn = new Map<string, Set<string>>();
  // A steer still in flight to the CLI escapes a cancel_queued interrupt, and the CLI then runs it;
  // CLIs advertising msg_lifecycle_v1 ack each message within milliseconds, so a Stop waits for that.
  const acks = new Map<string, Deferred.Deferred<void>>();
  let cliAcks = false;

  const drop = (turnId: string, uuid: string) => {
    pendingByTurn.get(turnId)?.delete(uuid);
    acks.delete(uuid);
  };

  return {
    add: Effect.fnUntraced(function* (turnId: string, uuid: string) {
      const pending = pendingByTurn.get(turnId) ?? new Set<string>();
      pendingByTurn.set(turnId, pending.add(uuid));
      acks.set(uuid, yield* Deferred.make<void>());
    }),
    /** The steer never reached the query, so no result will answer for it. */
    drop,
    /** Forgets the steers a result answered for; true while the turn still waits on one. */
    answered: (turnId: string, uuids: ReadonlyArray<string>): boolean => {
      for (const uuid of uuids) drop(turnId, uuid);
      // A result listing no uuids proves nothing, so it ends the turn as before.
      return uuids.length > 0 && (pendingByTurn.get(turnId)?.size ?? 0) > 0;
    },
    pending: (turnId: string): ReadonlyArray<string> => [...(pendingByTurn.get(turnId) ?? [])],
    clear: (turnId: string) => {
      for (const uuid of pendingByTurn.get(turnId) ?? []) acks.delete(uuid);
      pendingByTurn.delete(turnId);
    },
    noteInit: (capabilities: ReadonlyArray<string> | undefined) => {
      cliAcks = capabilities?.includes("msg_lifecycle_v1") === true;
    },
    noteLifecycle: Effect.fnUntraced(function* (uuid: string | undefined) {
      const ack = uuid === undefined ? undefined : acks.get(uuid);
      if (uuid === undefined || ack === undefined) return;
      acks.delete(uuid);
      yield* Deferred.succeed(ack, undefined);
    }),
    awaitAcks: (uuids: ReadonlyArray<string>) =>
      cliAcks
        ? Effect.forEach(uuids, (uuid) => {
            const ack = acks.get(uuid);
            return ack === undefined ? Effect.void : Deferred.await(ack);
          }).pipe(Effect.timeoutOption(ACK_TIMEOUT_MS), Effect.asVoid)
        : Effect.void,
  };
};

// In the SDK runtime since 0.3.28x but not in sdk.d.ts.
interface ClaudeQueryQueueControls {
  readonly interrupt: (options?: { readonly cancelQueued: true }) => Promise<unknown>;
  readonly cancelAsyncMessage?: (uuid: string) => Promise<unknown>;
}

/**
 * Interrupts and withdraws the queued steers: in one request where the CLI advertises
 * interrupt_cancel_queued_v1, else one cancel per steer first. A cancel that throws or is missing
 * never keeps the interrupt from going out.
 */
export const interruptCancellingQueued = async (
  queryRuntime: object,
  uuids: ReadonlyArray<string>,
  cancelsQueued: boolean,
): Promise<void> => {
  const controls = queryRuntime as ClaudeQueryQueueControls;
  if (cancelsQueued) {
    await controls.interrupt({ cancelQueued: true });
    return;
  }
  for (const uuid of uuids) {
    try {
      await controls.cancelAsyncMessage?.(uuid);
    } catch {
      // An older CLI cannot cancel; the interrupt below still stops the turn.
    }
  }
  await controls.interrupt();
};
