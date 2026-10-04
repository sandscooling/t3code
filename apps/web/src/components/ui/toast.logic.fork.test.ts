// Fork-owned tests for toast.logic.test.ts.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { toastIdsToDismissForActiveThread } from "./toast.logic";

describe("toastIdsToDismissForActiveThread", () => {
  const activeThreadRef = {
    environmentId: "environment-a",
    threadId: "thread-1",
  } as ScopedThreadRef;
  const toastFor = (id: string, ref: ScopedThreadRef | null) => ({
    id,
    data: { dismissOnActiveThreadRef: ref },
  });

  it("dismisses every toast waiting on the thread now on screen", () => {
    assert.deepEqual(
      toastIdsToDismissForActiveThread(
        [toastFor("input", activeThreadRef), toastFor("approval", activeThreadRef)],
        activeThreadRef,
      ),
      ["input", "approval"],
    );
  });

  it("leaves toasts about other threads alone", () => {
    const other = { environmentId: "environment-a", threadId: "thread-2" } as ScopedThreadRef;
    const sameThreadElsewhere = {
      environmentId: "environment-b",
      threadId: "thread-1",
    } as ScopedThreadRef;
    assert.deepEqual(
      toastIdsToDismissForActiveThread(
        [toastFor("other", other), toastFor("elsewhere", sameThreadElsewhere)],
        activeThreadRef,
      ),
      [],
    );
  });

  it("skips a toast that is already closing, so closing it cannot loop", () => {
    assert.deepEqual(
      toastIdsToDismissForActiveThread(
        [
          { ...toastFor("closing", activeThreadRef), transitionStatus: "ending" },
          { ...toastFor("open", activeThreadRef), transitionStatus: "starting" },
        ],
        activeThreadRef,
      ),
      ["open"],
    );
  });

  it("ignores toasts that never asked to be dismissed, and drafts with no thread", () => {
    assert.deepEqual(
      toastIdsToDismissForActiveThread(
        [toastFor("unscoped", null), { id: "plain" }],
        activeThreadRef,
      ),
      [],
    );
    assert.deepEqual(
      toastIdsToDismissForActiveThread([toastFor("input", activeThreadRef)], null),
      [],
    );
  });
});
