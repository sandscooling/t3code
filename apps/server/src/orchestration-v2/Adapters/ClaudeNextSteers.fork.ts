/**
 * Fork-owned: a Stop withdraws the steers Claude has queued but not read, so none runs as a new
 * turn after the interrupt. Upstream sends steers at priority "next" and tracks which are unread.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** How long a Stop waits for the CLI to acknowledge a steer still in flight to it. */
const ACK_TIMEOUT_MS = 2_000;

export const makeClaudeSteerAcks = () => {
  // A steer still in flight to the CLI escapes a cancel_queued interrupt, and the CLI then runs it;
  // CLIs advertising msg_lifecycle_v1 ack each message within milliseconds, so a Stop waits for that.
  const acks = new Map<string, Deferred.Deferred<void>>();
  let cliAcks = false;

  return {
    add: Effect.fnUntraced(function* (uuid: string) {
      acks.set(uuid, yield* Deferred.make<void>());
    }),
    forget: (uuids: Iterable<string>) => {
      for (const uuid of uuids) acks.delete(uuid);
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
