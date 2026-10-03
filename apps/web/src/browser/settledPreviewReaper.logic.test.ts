import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { selectReapableThreadKeys } from "./settledPreviewReaper.logic";

type ReaperShell = Pick<EnvironmentThreadShell, "settledOverride">;

function makeShell(input: {
  readonly id: string;
  readonly settledOverride?: "settled" | "active" | null;
}): readonly [string, ReaperShell] {
  return [input.id, { settledOverride: input.settledOverride ?? null }];
}

function reap(input: {
  readonly previewThreadKeys: ReadonlyArray<string>;
  readonly shells: ReadonlyArray<readonly [string, ReaperShell]>;
  readonly onScreen?: ReadonlyArray<string>;
}) {
  return selectReapableThreadKeys({
    previewThreadKeys: input.previewThreadKeys,
    shellByThreadKey: new Map(input.shells),
    onScreenThreadKeys: new Set(input.onScreen ?? []),
  });
}
describe("selectReapableThreadKeys", () => {
  it("reaps a thread the server has stamped settled", () => {
    const shell = makeShell({ id: "settled", settledOverride: "settled" });
    expect(reap({ previewThreadKeys: ["settled"], shells: [shell] })).toEqual(["settled"]);
  });

  it("leaves an unsettled thread alone", () => {
    const shell = makeShell({ id: "fresh" });
    expect(reap({ previewThreadKeys: ["fresh"], shells: [shell] })).toEqual([]);
  });

  it("never reaps the thread on screen, even once it settles", () => {
    const shell = makeShell({ id: "open", settledOverride: "settled" });
    expect(reap({ previewThreadKeys: ["open"], shells: [shell], onScreen: ["open"] })).toEqual([]);
  });

  it("leaves a keep-active pin alone", () => {
    const shell = makeShell({ id: "pinned", settledOverride: "active" });
    expect(reap({ previewThreadKeys: ["pinned"], shells: [shell] })).toEqual([]);
  });

  it("treats a thread with no loaded shell as unknown rather than idle", () => {
    expect(reap({ previewThreadKeys: ["ghost"], shells: [] })).toEqual([]);
  });

  it("reaps only the settled subset when several threads hold tabs", () => {
    const settled = makeShell({ id: "settled", settledOverride: "settled" });
    const fresh = makeShell({ id: "fresh" });
    const viewed = makeShell({ id: "viewed", settledOverride: "settled" });
    expect(
      reap({
        previewThreadKeys: ["settled", "fresh", "viewed"],
        shells: [settled, fresh, viewed],
        onScreen: ["viewed"],
      }),
    ).toEqual(["settled"]);
  });
});
