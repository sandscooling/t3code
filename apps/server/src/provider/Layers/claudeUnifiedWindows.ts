/**
 * Fork: the account-wide windows on every streamed `rate_limit_event`.
 *
 * The CLI only sets the top-level `utilization` once the named window passes a
 * warning threshold, but every event carries each account-wide window under
 * `unifiedWindows`. Reading those keeps the bars live for an account with
 * headroom, whose `get_usage` probe may be too slow to land.
 *
 * @module provider/Layers/claudeUnifiedWindows
 */
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderUsageLimitsUpdate, ServerProviderUsageWindow } from "@t3tools/contracts";

/** `unifiedWindows` is on the wire but not in the SDK typings we pin. */
function readUnifiedWindows(
  info: SDKRateLimitInfo,
): ReadonlyArray<readonly [string, { readonly utilization: number; readonly resetsAt?: number }]> {
  const raw = (info as { readonly unifiedWindows?: unknown }).unifiedWindows;
  if (typeof raw !== "object" || raw === null) return [];
  return Object.entries(raw).flatMap(([id, window]) => {
    if (typeof window !== "object" || window === null) return [];
    const { utilization, resetsAt } = window as { utilization?: unknown; resetsAt?: unknown };
    if (typeof utilization !== "number") return [];
    return [[id, { utilization, ...(typeof resetsAt === "number" ? { resetsAt } : {}) }] as const];
  });
}

/**
 * Merge the event's `unifiedWindows` under the window the event names.
 * `toWindow` maps one unified entry (0-1 utilization, epoch-seconds reset) to
 * a row, or `undefined` for a window the pill does not draw. A named window
 * wins over the unified entry with the same id.
 */
export function withClaudeUnifiedWindows(
  info: SDKRateLimitInfo,
  toWindow: (
    id: string,
    utilization: number,
    resetsAt: number | undefined,
  ) => ServerProviderUsageWindow | undefined,
  named: ProviderUsageLimitsUpdate | undefined,
): ProviderUsageLimitsUpdate | undefined {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [id, window] of readUnifiedWindows(info)) {
    const row = toWindow(id, window.utilization, window.resetsAt);
    if (row) {
      windows.set(id, row);
    }
  }
  for (const window of named?.windows ?? []) {
    windows.set(window.id, window);
  }
  return windows.size > 0 ? { windows: [...windows.values()] } : undefined;
}
