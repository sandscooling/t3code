/**
 * AttentionBus - in-memory fan-out for `session_notify` pings.
 *
 * A ping is a doorbell: an agent decides the user is needed in person, every
 * client attached to this server rings once, and nothing is written down. It is
 * deliberately not an orchestration event. The reason the agent rang is already
 * in its thread, a stored ping would ring again on the next reconnect replay,
 * and a doorbell that rings for yesterday's question is worse than none.
 *
 * @module AttentionBus
 */
import type { AttentionPing } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export interface AttentionBusShape {
  /**
   * Rings every subscriber. Returns how many were listening, which is what the
   * tool reports back: zero means the ping went nowhere, and an agent that is
   * told so can say it rather than assume it was heard.
   */
  readonly publish: (ping: AttentionPing) => Effect.Effect<number>;
  readonly subscribe: () => Stream.Stream<AttentionPing>;
}

export class AttentionBus extends Context.Service<AttentionBus, AttentionBusShape>()(
  "t3/attention/AttentionBus",
) {}

export const layer = Layer.effect(AttentionBus)(
  Effect.gen(function* () {
    // Dropping is the right failure mode for a doorbell: a client too slow to
    // take a ping is a client that is not listening, and queueing pings would
    // ring a burst at whoever reconnects.
    const pings = yield* Effect.acquireRelease(PubSub.dropping<AttentionPing>(16), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    // PubSub does not expose its subscriber count, and the count is the only
    // honest answer to "did anyone hear that", so it is tracked here.
    const listeners = yield* Ref.make(0);

    return AttentionBus.of({
      publish: (ping) =>
        Effect.gen(function* () {
          const reached = yield* Ref.get(listeners);
          yield* PubSub.publish(pings, ping);
          return reached;
        }),
      subscribe: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(listeners, (count) => count + 1);
            return Stream.fromPubSub(pings).pipe(
              Stream.ensuring(Ref.update(listeners, (count) => Math.max(0, count - 1))),
            );
          }),
        ),
    });
  }),
);
