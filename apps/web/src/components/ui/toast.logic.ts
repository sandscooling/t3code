import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";

/**
 * Base UI toast updates omit `undefined` fields, so callers that need to remove
 * an action must pass a defined `actionProps` whose `children` are empty.
 * Treat that payload (and missing children) as "no visible action".
 */
export function hasVisibleToastAction(actionProps: unknown): boolean {
  if (actionProps == null || typeof actionProps !== "object") {
    return false;
  }
  if (!("children" in actionProps)) {
    return false;
  }
  const children = actionProps.children;
  return children != null && children !== false && children !== "";
}

export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  // Keep the front-most toast readable even if Base UI marks it as "behind"
  // due to toasts hidden by thread filtering.
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

type ToastWithHeight = {
  height?: number | null | undefined;
};

type ToastWithTransitionStatus = {
  transitionStatus?: "starting" | "ending" | undefined;
};

type ToastWithLayoutProps = ToastWithHeight & ToastWithTransitionStatus;

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithLayoutProps)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithLayoutProps>[];
} {
  // Two parallel cursors:
  //   - `full*`  advances on every toast, so an ending toast keeps the slot it
  //     occupied before dismissal and its data-ending-style exit transform
  //     originates from the correct position (critical for dismissing a
  //     non-front toast in the expanded stack — otherwise it would snap to
  //     Y=0 and slide off diagonally).
  //   - `live*`  advances only on non-ending toasts, so live toasts reflow
  //     past the vacated slot in parallel with the exit animation instead of
  //     waiting for it to finish (which caused a visible "stop and bump").
  let fullIndex = 0;
  let fullOffsetY = 0;
  let liveIndex = 0;
  let liveOffsetY = 0;

  const items: VisibleToastLayoutItem<TToast & ToastWithLayoutProps>[] = visibleToasts.map(
    (toast) => {
      const height = normalizeToastHeight(toast.height);

      if (toast.transitionStatus === "ending") {
        const item = {
          toast,
          visibleIndex: fullIndex,
          offsetY: fullOffsetY,
        };
        fullOffsetY += height;
        fullIndex += 1;
        return item;
      }

      const item = {
        toast,
        visibleIndex: liveIndex,
        offsetY: liveOffsetY,
      };

      fullOffsetY += height;
      fullIndex += 1;
      liveOffsetY += height;
      liveIndex += 1;
      return item;
    },
  );

  // Frontmost height should reflect the first non-ending (live) toast so the
  // stack sizes to what's actually staying on screen.
  const frontmostLiveToast = visibleToasts.find((toast) => toast.transitionStatus !== "ending");

  return {
    frontmostHeight: normalizeToastHeight(frontmostLiveToast?.height),
    items,
  };
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}

/**
 * Ids of toasts that asked to be retired once their thread is the one on screen.
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

export function shouldRenderThreadScopedToast(
  data:
    | {
        threadRef?: ScopedThreadRef | null;
        threadId?: ThreadId | null;
      }
    | undefined,
  activeThreadRef: ScopedThreadRef | null,
): boolean {
  if (data?.threadRef) {
    return (
      activeThreadRef !== null &&
      data.threadRef.environmentId === activeThreadRef.environmentId &&
      data.threadRef.threadId === activeThreadRef.threadId
    );
  }

  const toastThreadId = data?.threadId;
  if (!toastThreadId) {
    return true;
  }

  return activeThreadRef?.threadId === toastThreadId;
}
