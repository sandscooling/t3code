import type { ProviderRateLimitWindow, ProviderRateLimitWindowKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Normalizes the two provider-native rate-limit shapes onto
 * `ProviderRateLimitWindow`:
 *
 * - Claude (`rate_limit_event`) sends one window per event, tagged with
 *   `rateLimitType`. It names the window and when it resets but omits
 *   `utilization` in practice, so it cannot produce a usable window on its own.
 * - Claude (`/usage` control request) reports every plan window at once, each
 *   with a real utilization percentage. This is the only source of a
 *   percentage for Claude.
 * - Codex (`account/rateLimits/updated`) sends a `primary`/`secondary` pair
 *   identified only by `windowDurationMins`.
 *
 * Neither reports the size of the quota, so a window carries utilization and a
 * reset instant and nothing else.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * Epoch timestamps arrive in seconds from both providers, but neither schema
 * says so — anything past year-2001-in-milliseconds is treated as already
 * being milliseconds so a future switch to ms does not render dates in 1970.
 */
const EPOCH_MS_THRESHOLD = 1_000_000_000_000;

export function isoFromEpoch(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const milliseconds = value >= EPOCH_MS_THRESHOLD ? value : value * 1000;
  const instant = DateTime.make(milliseconds);
  return Option.isNone(instant) ? undefined : DateTime.formatIso(instant.value);
}

/** Clamps provider utilization onto 0-100; returns null when unusable. */
export function normalizeUsedPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

/**
 * Codex identifies windows only by duration. Buckets are generous because the
 * backend reports approximate durations (a "weekly" window has come through as
 * both 10080 and 10079 minutes).
 */
export function rateLimitWindowKindFromDurationMins(
  windowDurationMins: number | null | undefined,
): ProviderRateLimitWindowKind {
  if (typeof windowDurationMins !== "number" || !Number.isFinite(windowDurationMins)) {
    return "unknown";
  }
  if (windowDurationMins <= 12 * MINUTES_PER_HOUR) {
    return "five_hour";
  }
  if (windowDurationMins <= 10 * MINUTES_PER_DAY) {
    return "weekly";
  }
  return "monthly";
}

export function makeRateLimitWindow(input: {
  readonly kind: ProviderRateLimitWindowKind;
  readonly usedPercent: number | null;
  readonly resetsAt?: string | undefined;
  readonly windowDurationMins?: number | null | undefined;
  readonly status?: ProviderRateLimitWindow["status"];
}): ProviderRateLimitWindow | null {
  if (input.usedPercent === null) {
    return null;
  }
  const windowDurationMins =
    typeof input.windowDurationMins === "number" &&
    Number.isFinite(input.windowDurationMins) &&
    input.windowDurationMins > 0
      ? Math.round(input.windowDurationMins)
      : undefined;
  return {
    kind: input.kind,
    usedPercent: input.usedPercent,
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
}

/**
 * Plan windows as the `/usage` control request names them, mapped onto the
 * canonical kinds. `seven_day_oauth_apps` is deliberately absent: it meters
 * third-party OAuth apps rather than this account's own plan usage, and has no
 * canonical kind to land on.
 */
const CLAUDE_PLAN_WINDOW_KINDS: ReadonlyArray<
  readonly [key: string, kind: ProviderRateLimitWindowKind, windowDurationMins: number]
> = [
  ["five_hour", "five_hour", 5 * MINUTES_PER_HOUR],
  ["seven_day", "weekly", 7 * MINUTES_PER_DAY],
  ["seven_day_opus", "weekly_opus", 7 * MINUTES_PER_DAY],
  ["seven_day_sonnet", "weekly_sonnet", 7 * MINUTES_PER_DAY],
];

/**
 * Normalizes the `rate_limits` block of the SDK's `/usage` response. Returns
 * an empty array when plan limits do not apply (API key, Bedrock, Vertex), so
 * callers can treat "no windows" uniformly rather than branching on auth mode.
 */
export function claudePlanRateLimitWindows(rateLimits: unknown): Array<ProviderRateLimitWindow> {
  const record = asRecord(rateLimits);
  if (!record) {
    return [];
  }

  const windows: Array<ProviderRateLimitWindow> = [];
  for (const [key, kind, windowDurationMins] of CLAUDE_PLAN_WINDOW_KINDS) {
    const entry = asRecord(record[key]);
    if (!entry) {
      continue;
    }
    // `utilization` is already a 0-100 percentage here, unlike the epoch-second
    // `resetsAt` of the push event: this payload is ISO 8601 throughout.
    const window = makeRateLimitWindow({
      kind,
      usedPercent: normalizeUsedPercent(entry.utilization as number | null | undefined),
      resetsAt: typeof entry.resets_at === "string" ? entry.resets_at : undefined,
      windowDurationMins,
    });
    if (window) {
      windows.push(window);
    }
  }
  return windows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
