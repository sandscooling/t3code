import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * Fork: ids of toasts that asked to be retired once their thread is the one on screen.
 * A toast that nagged about a thread has said its piece as soon as the reader
 * arrives there, so opening the thread is itself the dismissal.
 *
 * A toast already closing is skipped: Base UI's close rewrites even an ending
 * toast, so closing it again changes the list, reruns the caller's effect, and
 * loops until React aborts the render.
 */
export function toastIdsToDismissForActiveThread<
  TToast extends {
    id: string;
    transitionStatus?: string | undefined;
    data?: { dismissOnActiveThreadRef?: ScopedThreadRef | null } | undefined;
  },
>(toasts: readonly TToast[], activeThreadRef: ScopedThreadRef | null): string[] {
  if (activeThreadRef === null) return [];
  return toasts
    .filter((toast) => {
      const ref = toast.data?.dismissOnActiveThreadRef;
      return (
        toast.transitionStatus !== "ending" &&
        ref != null &&
        ref.environmentId === activeThreadRef.environmentId &&
        ref.threadId === activeThreadRef.threadId
      );
    })
    .map((toast) => toast.id);
}
