// Fork-owned: the "New thread in... N" session fleet in the command palette.
import type { ReactNode } from "react";

/**
 * Spawning more than this many sessions at once is almost certainly a typo:
 * every session is a real provider subprocess, and in worktree-backed
 * projects each one also pays for a checkout and a setup-script run.
 */
const SESSION_SPAWN_LIMIT = 20;

/**
 * Group value shared by every "New thread in..." project list. The trailing
 * session count keys off this rather than a flag set at each call site: the
 * picker is reachable from the palette submenu and from the New thread intent,
 * and a third entry point that forgot the flag would silently lose the feature.
 */
export const NEW_THREAD_PROJECTS_GROUP = "projects";

/**
 * The row Tab completes to and Enter runs. Falls back to the first item because
 * the list highlights its first match on its own, so requiring an explicit
 * highlight would make both keys look broken on the common path of typing a few
 * letters and acting straight away.
 */
export function resolveSessionCountTarget<T extends { readonly value: string }>(input: {
  items: ReadonlyArray<T>;
  highlightedItemValue: string | null;
}): T | undefined {
  return input.items.find((item) => item.value === input.highlightedItemValue) ?? input.items[0];
}

/** The query Tab should complete to, or null when there is nothing to complete. */
export function resolveSessionCountCompletion(input: {
  target: { readonly title: ReactNode } | undefined;
  count: number | null;
}): string | null {
  const title = input.target?.title;
  if (typeof title !== "string") {
    return null;
  }
  return input.count === null ? `${title} ` : `${title} ${input.count}`;
}

export interface SessionSpawnQuery {
  /** The project filter with any trailing count removed. */
  readonly filterText: string;
  /** How many sessions to start, or null when the query names no count. */
  readonly count: number | null;
}

/**
 * Splits a trailing session count off the "New thread in..." query, so "fleet 5" filters by
 * "fleet" and asks for five sessions instead of emptying the project list. For a title ending in
 * a number ("Sprint 3") the count wins, and the filter still matches, so the palette shows what
 * it is about to do.
 */
export function parseSessionSpawnQuery(query: string): SessionSpawnQuery {
  const match = /^(.*\S)\s+(\d{1,2})$/.exec(query);
  if (!match) {
    return { filterText: query, count: null };
  }
  const count = Number(match[2]);
  if (count < 1 || count > SESSION_SPAWN_LIMIT) {
    return { filterText: query, count: null };
  }
  return { filterText: match[1] ?? "", count };
}

/**
 * Handles Enter and Tab in the palette input while a "New thread in..." list
 * is showing. Returns true when it consumed the key, so the caller stops there.
 */
export function handleSessionCountKey<
  T extends { readonly value: string; readonly title: ReactNode },
>(
  event: {
    readonly key: string;
    readonly shiftKey: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  },
  ctx: {
    readonly acceptsSessionCount: boolean;
    readonly count: number | null;
    /** Read only for Enter and Tab, so other keys skip building the list. */
    readonly items: () => ReadonlyArray<T>;
    readonly highlightedItemValue: string | null;
    readonly executeItem: (item: T) => void;
    readonly setQuery: (query: string) => void;
  },
): boolean {
  if (!ctx.acceptsSessionCount) {
    return false;
  }
  const target = () =>
    resolveSessionCountTarget({
      items: ctx.items(),
      highlightedItemValue: ctx.highlightedItemValue,
    });

  // The autocomplete drives Enter off its own active item, and a completed query
  // ("Fleet Cooling 5", or "Fleet Cooling " after Tab) matches none, so Enter did nothing.
  // Running the row this resolves to is what a click already does.
  if (event.key === "Enter") {
    const item = target();
    if (!item) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    ctx.executeItem(item);
    return true;
  }

  // Tab completes the resolved project into the search box, so the box shows
  // what is selected before a count is typed after it. Filtering by a few
  // letters otherwise leaves the box holding "fl" while the selection sits
  // somewhere below it.
  if (event.key === "Tab" && !event.shiftKey) {
    // Tab never leaves this box. Falling through would move focus to the back
    // arrow, which reads as the completion silently doing nothing, so an empty
    // list makes Tab a no-op instead.
    event.preventDefault();
    const completion = resolveSessionCountCompletion({ target: target(), count: ctx.count });
    if (completion !== null) {
      ctx.setQuery(completion);
    }
    return true;
  }

  return false;
}
