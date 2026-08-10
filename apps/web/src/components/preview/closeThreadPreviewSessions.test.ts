import type {
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { closeThreadPreviewSessions } from "./closeThreadPreviewSessions";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshotFor = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: {
    _tag: "Success",
    url: `http://localhost:3000/${tabId}`,
    title: "Local app",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

const first = snapshotFor("tab-1", "2026-06-18T19:00:00.000Z");
const second = snapshotFor("tab-2", "2026-06-18T19:01:00.000Z");

beforeEach(resetPreviewStateForTests);

describe("closeThreadPreviewSessions", () => {
  it("drops every session locally before the server acknowledges", async () => {
    applyPreviewServerSnapshot(threadRef, first);
    applyPreviewServerSnapshot(threadRef, second);
    let finishClose: (() => void) | undefined;
    const closePreview = vi.fn(
      (_input: PreviewCloseInput) =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
    );

    const closing = closeThreadPreviewSessions({
      closePreview: ({ input }) => closePreview(input),
      threadRef,
    });

    // The sidebar globe and ElectronBrowserHost both read this map, and a
    // background thread never receives the server's "closed" event.
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    // Stale list snapshots must not resurrect what is already closing.
    applyPreviewServerSnapshot(threadRef, first);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});

    finishClose?.();
    await closing;
    expect(closePreview).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("restores every session when the server close fails", async () => {
    applyPreviewServerSnapshot(threadRef, first);
    applyPreviewServerSnapshot(threadRef, second);

    const result = await closeThreadPreviewSessions({
      closePreview: async () => AsyncResult.failure(Cause.fail(new Error("close failed"))),
      threadRef,
    });

    expect(result._tag).toBe("Failure");
    expect(readThreadPreviewState(threadRef).sessions).toEqual({
      [first.tabId]: first,
      [second.tabId]: second,
    });
  });

  it("restores every session when the close throws", async () => {
    applyPreviewServerSnapshot(threadRef, first);

    await expect(
      closeThreadPreviewSessions({
        closePreview: async () => {
          throw new Error("transport died");
        },
        threadRef,
      }),
    ).rejects.toThrow("transport died");
    expect(readThreadPreviewState(threadRef).sessions).toEqual({ [first.tabId]: first });
  });

  it("still issues the thread-wide close when the local map is already empty", async () => {
    const closePreview = vi.fn(async () => AsyncResult.success(undefined));

    await closeThreadPreviewSessions({ closePreview, threadRef });

    expect(closePreview).toHaveBeenCalledTimes(1);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
  });
});
