import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { handedOffThreadIds } from "./handoffPortAttribution";

const id = ThreadId.make;
const index = (links: Record<string, string | null>, archived: ReadonlyArray<string> = []) =>
  new Map(
    Object.entries(links).map(
      ([thread, successor]) =>
        [
          id(thread),
          {
            successorThreadId: successor === null ? null : id(successor),
            archivedAt: archived.includes(thread) ? DateTime.makeUnsafe(0) : null,
            deletedAt: null,
          },
        ] as const,
    ),
  );

describe("handedOffThreadIds", () => {
  it("gives the live end of a handoff chain every thread that handed off to it", () => {
    const threads = index({ first: "second", second: "third", third: null, other: null });

    expect(handedOffThreadIds(threads, id("third"))).toEqual([id("first"), id("second")]);
    // A thread that handed off again no longer owns its predecessors' servers.
    expect(handedOffThreadIds(threads, id("second"))).toEqual([]);
    expect(handedOffThreadIds(threads, id("other"))).toEqual([]);
  });

  it("ends a chain at a cycle, an archived thread, or a link to a thread it does not know", () => {
    const threads = index({ a: "b", b: "a", stranded: "gone", lead: "archived", archived: null }, [
      "archived",
    ]);

    expect(handedOffThreadIds(threads, id("b"))).toEqual([id("a")]);
    expect(handedOffThreadIds(threads, id("a"))).toEqual([id("b")]);
    expect(handedOffThreadIds(threads, id("gone"))).toEqual([]);
    expect(handedOffThreadIds(threads, id("archived"))).toEqual([]);
  });
});
