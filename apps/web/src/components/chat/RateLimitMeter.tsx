import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn } from "@t3tools/shared/usageLimits";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function usageColor(usedPercent: number): string {
  if (usedPercent >= 90) {
    return "var(--color-red-500)";
  }
  if (usedPercent >= 75) {
    return "var(--color-amber-500)";
  }
  return "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  if (value > 0 && value < 1) {
    return "<1%";
  }
  return `${Math.round(value)}%`;
}

/** Highest utilization across windows, which is what the collapsed pill shows. */
function peakWindow(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProviderUsageWindow | undefined {
  return windows.reduce<ServerProviderUsageWindow | undefined>(
    (peak, window) => (peak === undefined || window.usedPercent > peak.usedPercent ? window : peak),
    undefined,
  );
}

function WindowRow(props: { window: ServerProviderUsageWindow; now: number }) {
  const { window, now } = props;
  const resetsIn = formatResetsIn(window, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-2xs leading-4">
        <span className="text-muted-foreground/60">{window.label}</span>
        <span className="font-medium tabular-nums text-muted-foreground/80">
          {formatPercent(window.usedPercent)}
          {resetsIn ? (
            <span className="ml-1 font-normal text-muted-foreground/60">· {resetsIn}</span>
          ) : null}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(window.usedPercent)}
        aria-label={`${window.label} usage limit`}
      >
        <div
          className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${Math.max(0, Math.min(100, window.usedPercent))}%`,
            backgroundColor: usageColor(window.usedPercent),
          }}
        />
      </div>
    </div>
  );
}

/**
 * The popover's rows, timed against the shared minute clock. The pill can sit
 * unrendered for an hour while a thread idles, so reading the clock in the pill
 * made every reset look that much further away when the popover opened.
 */
function WindowRows(props: { windows: ReadonlyArray<ServerProviderUsageWindow> }) {
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  return props.windows.map((window) => <WindowRow key={window.id} window={window} now={now} />);
}

/**
 * Plan usage windows (session / weekly) beside the context meter, read from the
 * provider instance's own limits snapshot. Providers report utilization only,
 * so every figure here is a percentage plus a reset time.
 */
export function RateLimitMeter(props: {
  limits: ServerProviderUsageLimits;
  providerDisplayName?: string | null;
}) {
  const { limits, providerDisplayName } = props;
  const peak = peakWindow(limits.windows);
  if (!peak) {
    return null;
  }
  const peakPercent = formatPercent(peak.usedPercent);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-transparent px-2 text-2xs text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={`Plan usage: ${peak.label} ${peakPercent} used`}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: usageColor(peak.usedPercent) }}
              aria-hidden="true"
            />
            <span className="tabular-nums">
              {peak.label} {peakPercent}
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Plan usage</div>
            {providerDisplayName ? (
              <div className="text-2xs text-muted-foreground/70">{providerDisplayName}</div>
            ) : null}
          </div>
          <WindowRows windows={limits.windows} />
          <div className="mt-1 text-pretty text-2xs font-medium text-muted-foreground/70">
            {providerDisplayName ?? "This provider"} reports how much of each window is used, not
            the size of the limit.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
