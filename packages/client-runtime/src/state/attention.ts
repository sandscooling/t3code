/**
 * Attention pings: an agent asking for the user in person.
 *
 * The stream carries doorbells, not state, so the atom holds only the most
 * recent ping. A client rings once per ping and never replays one: a ping that
 * arrived while nothing was listening is a ping nobody needed to hear twice.
 *
 * @module attention
 */
import { WS_METHODS, type AttentionPing, type EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

/** Long enough to survive a tab switch, short enough to drop a dead server. */
const ATTENTION_IDLE_TTL_MS = 10 * 60_000;

export function createAttentionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const latestPing = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:attention:pings",
    idleTtlMs: ATTENTION_IDLE_TTL_MS,
    subscribe: () => subscribe(WS_METHODS.subscribeAttention, {}),
  });

  return {
    /** Latest ping from this environment, or a pending result before the first. */
    latestPing: (target: { readonly environmentId: EnvironmentId }) =>
      latestPing({ environmentId: target.environmentId, input: {} }),
  };
}

/**
 * Whether a ping should ring, given what this client has already heard.
 *
 * Two guards, both load-bearing. A ping is identified by thread and time, so a
 * re-render or a re-subscribe cannot ring the same one twice. And a ping older
 * than the freshness window is dropped: the subscription re-attaches on
 * reconnect, and ringing for a question the user answered an hour ago teaches
 * them to ignore the sound.
 */
export const ATTENTION_FRESHNESS_MS = 2 * 60_000;

export function attentionPingKey(ping: AttentionPing): string {
  return `${ping.threadId}:${ping.requestedAt}`;
}

export function shouldRingAttentionPing(input: {
  readonly ping: AttentionPing;
  readonly lastRungKey: string | null;
  readonly nowMs: number;
}): boolean {
  const key = attentionPingKey(input.ping);
  if (key === input.lastRungKey) return false;
  const requestedAtMs = Date.parse(input.ping.requestedAt);
  if (!Number.isFinite(requestedAtMs)) return false;
  const ageMs = input.nowMs - requestedAtMs;
  // A clock skewed into the future still rings: the ping is certainly not stale.
  return ageMs <= ATTENTION_FRESHNESS_MS;
}
