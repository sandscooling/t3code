import type {
  OrchestrationThreadActivity,
  ProviderRateLimitWindow,
  ProviderRateLimitWindowKind,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type RateLimitWindowSnapshot = ProviderRateLimitWindow & {
  /** When the activity carrying this window was recorded. */
  readonly updatedAt: string;
};

export type RateLimitSnapshot = {
  readonly windows: ReadonlyArray<RateLimitWindowSnapshot>;
  readonly planLabel: string | null;
  readonly updatedAt: string;
};

/**
 * Kind ordering for display: the window a user hits first comes first, and the
 * model-specific weekly windows sit after the plan-wide one.
 */
const WINDOW_ORDER: ReadonlyArray<ProviderRateLimitWindowKind> = [
  "five_hour",
  "weekly",
  "weekly_opus",
  "weekly_sonnet",
  "monthly",
  "overage",
  "unknown",
];

const WINDOW_LABELS: Record<ProviderRateLimitWindowKind, string> = {
  five_hour: "5h",
  weekly: "Weekly",
  weekly_opus: "Weekly (Opus)",
  weekly_sonnet: "Weekly (Sonnet)",
  monthly: "Monthly",
  overage: "Extra usage",
  unknown: "Usage",
};

function isWindowKind(value: unknown): value is ProviderRateLimitWindowKind {
  return typeof value === "string" && value in WINDOW_LABELS;
}

export function formatRateLimitWindowLabel(window: {
  readonly kind: ProviderRateLimitWindowKind;
  readonly windowDurationMins?: number | undefined;
}): string {
  if (window.kind !== "unknown") {
    return WINDOW_LABELS[window.kind];
  }
  const minutes = window.windowDurationMins;
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return WINDOW_LABELS.unknown;
  }
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  if (minutes < 24 * 60) {
    return `${Math.round(minutes / 60)}h`;
  }
  return `${Math.round(minutes / (24 * 60))}d`;
}

function parseWindow(value: unknown): ProviderRateLimitWindow | null {
  const record = asRecord(value);
  const usedPercent = asFiniteNumber(record?.usedPercent);
  if (!record || usedPercent === null) {
    return null;
  }
  const kind = isWindowKind(record.kind) ? record.kind : "unknown";
  const resetsAt = typeof record.resetsAt === "string" ? record.resetsAt : undefined;
  const windowDurationMins = asFiniteNumber(record.windowDurationMins);
  const status =
    record.status === "allowed" || record.status === "warning" || record.status === "rejected"
      ? record.status
      : undefined;
  return {
    kind,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMins !== null ? { windowDurationMins } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/**
 * Merges the newest observation of each window kind. Both Claude and Codex send
 * sparse updates — Claude one window per event, Codex only the windows that
 * changed — so the latest activity alone does not describe current usage.
 */
export function deriveRateLimitSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly now?: number },
): RateLimitSnapshot | null {
  const now = options?.now ?? Date.now();
  const byKind = new Map<ProviderRateLimitWindowKind, RateLimitWindowSnapshot>();
  let planLabel: string | null = null;
  let updatedAt: string | null = null;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "rate-limits.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const windows = payload?.windows;
    if (!Array.isArray(windows)) {
      continue;
    }
    if (planLabel === null && typeof payload?.planLabel === "string") {
      planLabel = payload.planLabel;
    }
    for (const raw of windows) {
      const window = parseWindow(raw);
      // The backward walk reaches the newest observation of a kind first.
      if (!window || byKind.has(window.kind)) {
        continue;
      }
      // A window whose reset has passed says nothing about current usage, and
      // no fresher event arrives until the next turn.
      if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) {
        continue;
      }
      byKind.set(window.kind, { ...window, updatedAt: activity.createdAt });
      if (updatedAt === null || activity.createdAt > updatedAt) {
        updatedAt = activity.createdAt;
      }
    }
  }

  if (byKind.size === 0 || updatedAt === null) {
    return null;
  }

  const windows = [...byKind.values()].toSorted(
    (left, right) => WINDOW_ORDER.indexOf(left.kind) - WINDOW_ORDER.indexOf(right.kind),
  );
  return { windows, planLabel, updatedAt };
}

/** Highest utilization across windows — what the collapsed meter shows. */
export function peakRateLimitWindow(
  snapshot: RateLimitSnapshot,
): RateLimitWindowSnapshot | undefined {
  return snapshot.windows.reduce<RateLimitWindowSnapshot | undefined>(
    (peak, window) => (peak === undefined || window.usedPercent > peak.usedPercent ? window : peak),
    undefined,
  );
}

export function formatRateLimitPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  if (value > 0 && value < 1) {
    return "<1%";
  }
  return `${Math.round(value)}%`;
}

/**
 * Compact "resets in" phrasing. Returns null once the reset is in the past so
 * callers can drop the line rather than render "resets in 0m".
 */
export function formatRateLimitReset(resetsAt: string, now: number = Date.now()): string | null {
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) {
    return null;
  }
  const deltaMinutes = Math.round((target - now) / 60_000);
  if (deltaMinutes <= 0) {
    return null;
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 24) {
    const minutes = deltaMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}
