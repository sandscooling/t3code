import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { isSilencedCrewAlert } from "@t3tools/shared/crewSession"; // Fork: quiet crew completions
import { backgroundWorkTaskHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork"; // Fork
import type { AnyRouter } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
// Fork: no completion toast, so no CircleCheckIcon.
import { CircleAlertIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

/**
 * Fork: stable id for the toast that waits on one thread's answer, so a follow-up
 * event on the same thread replaces it rather than stacking a duplicate, and so
 * the coordinator can retire it later without tracking the id itself.
 */
function attentionToastId(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `thread-attention:${environmentId}:${threadId}`;
}

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  // Fork: an unchanged thread is skipped, so it must still count as awaiting.
  readonly awaitsAnswer: boolean;
  // Fork: a held command keeps the thread waiting on its completion alert.
  readonly holdsCompletion: boolean;
}

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  // Fork: threads with a standing answer toast open. Unlike `previous` it
  // survives a disconnect, so an answer that landed meanwhile still clears it.
  readonly standing: Set<ThreadId>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<string, { environmentId: EnvironmentId; notification: Notification }>();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  const isActiveThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    return active.environmentId === environmentId && active.threadId === threadId;
  };
  // Fork: questions and approvals stand until answered; failures and limits fall
  // away on their own. Completions have no toast at all.
  const showToast = (
    environmentId: EnvironmentId,
    standing: Set<ThreadId>,
    { thread, status, awaitsAnswer }: NotificationState,
    title: string,
  ) => {
    if (awaitsAnswer) standing.add(thread.id);
    const toastId = toastManager.add({
      ...(awaitsAnswer
        ? { id: attentionToastId(environmentId, thread.id), timeout: 0 }
        : undefined),
      type: status === "failed" ? "error" : "warning",
      title,
      description: thread.title,
      data: {
        hideCopyButton: true,
        dismissOnActiveThreadRef: awaitsAnswer ? { environmentId, threadId: thread.id } : null,
        leadingIcon:
          status === "approval" ? (
            <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ) : status === "failed" ? (
            <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
          ) : (
            <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
          ),
      },
      actionProps: {
        children: "Open thread",
        onClick: () => {
          toastManager.close(toastId);
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        },
      },
    });
  };
  // Fork: first sight, such as after a restart: a thread already waiting on an
  // answer gets its standing toast back, quietly. The stable id refreshes it.
  const restoreStandingToast = (
    environmentId: EnvironmentId,
    standing: Set<ThreadId>,
    state: NotificationState,
  ) => {
    if (!getClientSettings().inAppNotificationsEnabled) return;
    if (isActiveThread(environmentId, state.thread.id)) return;
    showToast(
      environmentId,
      standing,
      state,
      state.status === "approval" ? "Approval needed" : "Input needed",
    );
  };

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = (
    environmentId: EnvironmentId,
    standing: Set<ThreadId>,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, status } = state;
    // Fork: a crew session finishing a turn is idle, not done, so it stays quiet.
    if (isSilencedCrewAlert(thread, kind)) return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    const onScreen = document.visibilityState === "visible" && document.hasFocus();
    // Fork: a question must still be waiting when the reader comes back, so its
    // toast does not depend on focus (a browser preview or dictation can hold it).
    // A background question still gets its system popup below.
    if (
      kind === "input" &&
      inAppNotificationsEnabled &&
      !isActiveThread(environmentId, thread.id) &&
      (state.awaitsAnswer || onScreen)
    ) {
      showToast(environmentId, standing, state, title);
      if (onScreen) return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      onScreen ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    const awaiting = new Set<ThreadId>(); // Fork: threads still waiting on an answer
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest
      ) {
        next.set(rawThread.id, prior);
        if (prior.awaitsAnswer) awaiting.add(rawThread.id); // Fork
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
        // Fork: only questions and approvals want an answer, so only they stand.
        awaitsAnswer: thread.archivedAt === null && (status === "input" || status === "approval"),
        holdsCompletion:
          status === "waiting" &&
          thread.pendingBackgroundTasks.some(
            (task) => task.kind === "command" && backgroundWorkTaskHoldsCompletion(task),
          ),
      };
      next.set(thread.id, state);
      if (state.awaitsAnswer) awaiting.add(thread.id); // Fork
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    // Fork: forgetting a thread while a held command runs re-arms its completion,
    // so a completion that already alerted alerts again when the command ends.
    entry.gate.retain(
      new Set([...next].filter(([, state]) => !state.holdsCompletion).map(([id]) => id)),
    );
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
      if (!prior && state.awaitsAnswer) restoreStandingToast(environmentId, entry.standing, state); // Fork
    }
    // Fork: a standing toast becomes a stale label the moment its thread stops
    // asking: answered anywhere (even while disconnected), turned into a
    // failure or limit, archived, or gone.
    for (const threadId of entry.standing) {
      if (awaiting.has(threadId)) continue;
      toastManager.close(attentionToastId(environmentId, threadId));
      entry.standing.delete(threadId);
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      standing: new Set(), // Fork
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, entry.standing, state, kind);
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.gate.cancelPending();
        entry.reconnecting = true;
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    const unsubscribeDelegated = registry.subscribe(
      environmentThreadShells.delegatedUnderParentAtom,
      reobserve,
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
  };
}
