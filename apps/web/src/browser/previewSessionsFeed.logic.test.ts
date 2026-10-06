import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import {
  applyEnvironmentPreviewEvent,
  previewThreadRefsIn,
  relistPreviewThread,
} from "./previewSessionsFeed.logic";

const environmentId = "env-1" as EnvironmentId;
// Never routed: nothing mounts usePreviewSession for it in these tests.
const backgroundThread = scopeThreadRef(environmentId, ThreadId.make("thread-background"));

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: backgroundThread.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `http://localhost:3000/${tabId}`, title: "App" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-06T19:00:00.000Z",
});

const opened = (tabId: string, revision: number, serverEpoch = "epoch-a"): PreviewEvent => ({
  type: "opened",
  threadId: backgroundThread.threadId,
  tabId,
  createdAt: "2026-10-06T19:00:00.000Z",
  serverEpoch,
  revision,
  snapshot: snapshot(tabId),
});

const closed = (tabId: string, revision: number): PreviewEvent => ({
  type: "closed",
  threadId: backgroundThread.threadId,
  tabId,
  createdAt: "2026-10-06T19:01:00.000Z",
  serverEpoch: "epoch-a",
  revision,
});

const listResult = (tabIds: string[], revision: number): PreviewListResult => ({
  sessions: tabIds.map(snapshot),
  serverEpoch: "epoch-a",
  revision,
});

beforeEach(resetPreviewStateForTests);

describe("applyEnvironmentPreviewEvent", () => {
  it("lands a background thread's open and close in the store", () => {
    const relist = vi.fn();

    applyEnvironmentPreviewEvent(environmentId, opened("tab-1", 1), relist);
    expect(Object.keys(readThreadPreviewState(backgroundThread).sessions)).toEqual(["tab-1"]);

    applyEnvironmentPreviewEvent(environmentId, closed("tab-1", 2), relist);
    expect(readThreadPreviewState(backgroundThread).sessions).toEqual({});
    expect(relist).not.toHaveBeenCalled();
  });

  it("lists the thread again when the server restarted", () => {
    applyPreviewServerEvent(backgroundThread, opened("tab-1", 1));
    const relist = vi.fn();

    // The store drops another epoch's event, so applying it would change nothing.
    applyEnvironmentPreviewEvent(environmentId, opened("tab-2", 1, "epoch-b"), relist);

    expect(relist).toHaveBeenCalledWith(backgroundThread);
    expect(Object.keys(readThreadPreviewState(backgroundThread).sessions)).toEqual(["tab-1"]);
  });
});

describe("relistPreviewThread", () => {
  it("drops a tab that closed while the client was not listening", async () => {
    applyPreviewServerEvent(backgroundThread, opened("tab-1", 1));
    applyPreviewServerEvent(backgroundThread, opened("tab-2", 2));

    await relistPreviewThread(backgroundThread, async () =>
      AsyncResult.success(listResult(["tab-2"], 3)),
    );

    expect(Object.keys(readThreadPreviewState(backgroundThread).sessions)).toEqual(["tab-2"]);
  });

  it("keeps the current sessions when the list fails", async () => {
    applyPreviewServerEvent(backgroundThread, opened("tab-1", 1));

    await relistPreviewThread(backgroundThread, async () =>
      AsyncResult.failure(Cause.fail("offline")),
    );

    expect(Object.keys(readThreadPreviewState(backgroundThread).sessions)).toEqual(["tab-1"]);
  });
});

describe("previewThreadRefsIn", () => {
  it("keeps only the given environment's threads", () => {
    const otherThread = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-other"));

    expect(
      previewThreadRefsIn(environmentId, [
        scopedThreadKey(backgroundThread),
        scopedThreadKey(otherThread),
        "not-a-thread-key",
      ]),
    ).toEqual([backgroundThread]);
  });
});
