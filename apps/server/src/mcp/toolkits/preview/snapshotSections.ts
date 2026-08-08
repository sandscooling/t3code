import {
  PREVIEW_AUTOMATION_SNAPSHOT_SECTIONS,
  type PreviewAutomationSnapshotSection,
} from "@t3tools/contracts";

/**
 * Snapshot payload keys each section owns. `diagnostics` covers two, which is
 * why this is a mapping rather than the section names being used directly.
 */
const SECTION_KEYS: Record<PreviewAutomationSnapshotSection, ReadonlyArray<string>> = {
  screenshot: ["screenshot"],
  accessibilityTree: ["accessibilityTree"],
  interactiveElements: ["interactiveElements"],
  visibleText: ["visibleText"],
  diagnostics: ["consoleEntries", "networkEntries"],
  actionTimeline: ["actionTimeline"],
};

/** Always returned: these identify the page and cost almost nothing. */
const ALWAYS_INCLUDED_KEYS = ["url", "title", "loading"] as const;

/**
 * Sections a snapshot call asked for, defaulting to all of them.
 *
 * An absent, empty, or unrecognized `include` means "no preference" rather than
 * "nothing": a snapshot with every section stripped is never what a caller
 * wants, and silently returning an empty one would read as a broken page rather
 * than a bad argument.
 */
export function selectPreviewSnapshotSections(
  payload: unknown,
): ReadonlySet<PreviewAutomationSnapshotSection> {
  const include = (payload as { readonly include?: unknown } | null | undefined)?.include;
  if (!Array.isArray(include)) {
    return new Set(PREVIEW_AUTOMATION_SNAPSHOT_SECTIONS);
  }
  const requested = include.filter((section): section is PreviewAutomationSnapshotSection =>
    (PREVIEW_AUTOMATION_SNAPSHOT_SECTIONS as ReadonlyArray<string>).includes(section as string),
  );
  return requested.length === 0
    ? new Set(PREVIEW_AUTOMATION_SNAPSHOT_SECTIONS)
    : new Set(requested);
}

/** Drop the snapshot keys whose section was not requested. */
export function pickPreviewSnapshotSections(
  page: Record<string, unknown>,
  requested: ReadonlySet<PreviewAutomationSnapshotSection>,
): Record<string, unknown> {
  const allowed = new Set<string>(ALWAYS_INCLUDED_KEYS);
  for (const section of requested) {
    for (const key of SECTION_KEYS[section]) {
      allowed.add(key);
    }
  }
  return Object.fromEntries(Object.entries(page).filter(([key]) => allowed.has(key)));
}
