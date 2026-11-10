import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { handedOffThreadIds } from "./handoffPortAttribution";

const id = ThreadId.make;
type Shell = {
  readonly successor?: string;
  readonly predecessors?: ReadonlyArray<string>;
  readonly archived?: boolean;
};
const index = (threads: Record<string, Shell>) =>
  new Map(
    Object.entries(threads).map(
      ([thread, shell]) =>
        [
          id(thread),
          {
            successorThreadId: shell.successor === undefined ? null : id(shell.successor),
            ...(shell.predecessors === undefined
              ? {}
              : { handoffPredecessorThreadIds: shell.predecessors.map((thread) => id(thread)) }),
            archivedAt: shell.archived === true ? DateTime.makeUnsafe(0) : null,
            deletedAt: null,
          },
        ] as const,
    ),
  );

describe("handedOffThreadIds", () => {
  it("gives a live successor every predecessor it recorded, though their threads are gone", () => {
    // The install prune deleted first and second; only third's own shell remains.
    const threads = index({ third: { predecessors: ["second", "first"] }, other: {} });

    expect(handedOffThreadIds(threads, id("third"))).toEqual([id("second"), id("first")]);
    expect(handedOffThreadIds(threads, id("other"))).toEqual([]);
    expect(handedOffThreadIds(threads, id("unknown"))).toEqual([]);
  });

  it("gives nothing to a thread that handed off to a live one, and gives it back once that one is gone", () => {
    const live = index({
      second: { successor: "third", predecessors: ["first"] },
      third: { predecessors: ["second", "first"] },
    });
    expect(handedOffThreadIds(live, id("second"))).toEqual([]);

    const archived = index({
      second: { successor: "third", predecessors: ["first"] },
      third: { predecessors: ["second", "first"], archived: true },
    });
    expect(handedOffThreadIds(archived, id("second"))).toEqual([id("first")]);

    const missing = index({ second: { successor: "third", predecessors: ["first"] } });
    expect(handedOffThreadIds(missing, id("second"))).toEqual([id("first")]);
  });
});
