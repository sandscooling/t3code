import { cn } from "~/lib/utils";
import {
  formatRateLimitPercent,
  formatRateLimitReset,
  formatRateLimitWindowLabel,
  peakRateLimitWindow,
  type RateLimitSnapshot,
  type RateLimitWindowSnapshot,
} from "~/lib/rateLimits";
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

function WindowRow(props: { window: RateLimitWindowSnapshot }) {
  const { window } = props;
  const resetsIn = window.resetsAt ? formatRateLimitReset(window.resetsAt) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
        <span className="text-muted-foreground/60">{formatRateLimitWindowLabel(window)}</span>
        <span className="font-medium tabular-nums text-muted-foreground/80">
          {formatRateLimitPercent(window.usedPercent)}
          {resetsIn ? (
            <span className="ml-1 font-normal text-muted-foreground/60">
              · resets in {resetsIn}
            </span>
          ) : null}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(window.usedPercent)}
        aria-label={`${formatRateLimitWindowLabel(window)} usage limit`}
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
 * Plan usage windows (5h / weekly) beside the context meter. Providers report
 * utilization only — there is no quota size to show — so every figure here is a
 * percentage plus a reset time.
 */
export function RateLimitMeter(props: {
  snapshot: RateLimitSnapshot;
  providerDisplayName?: string | null;
}) {
  const { snapshot, providerDisplayName } = props;
  const peak = peakRateLimitWindow(snapshot);
  if (!peak) {
    return null;
  }
  const peakLabel = formatRateLimitWindowLabel(peak);
  const peakPercent = formatRateLimitPercent(peak.usedPercent);

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
              "inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-transparent px-2 text-[11px] text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={`Plan usage: ${peakLabel} ${peakPercent} used`}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: usageColor(peak.usedPercent) }}
              aria-hidden="true"
            />
            <span className="tabular-nums">
              {peakLabel} {peakPercent}
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Plan usage</div>
            {snapshot.planLabel ? (
              <div className="text-[11px] text-muted-foreground/70 capitalize">
                {snapshot.planLabel}
              </div>
            ) : null}
          </div>
          {snapshot.windows.map((window) => (
            <WindowRow key={window.kind} window={window} />
          ))}
          <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
            {providerDisplayName ?? "This provider"} reports how much of each window is used, not
            the size of the limit.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
