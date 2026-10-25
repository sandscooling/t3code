import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { isSilencedCrewAlert } from "@t3tools/shared/crewSession"; // Fork: quiet crew completions
import { backgroundWorkTaskHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork"; // Fork
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
// Fork: no completion toast, so no CircleCheckIcon.
import { CircleAlertIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
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

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
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

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());
  // Fork: threads with a standing answer toast open. Unlike `previous` it
  // survives a disconnect, so an answer that landed meanwhile still clears it.
  const standing = useRef(new Set<ThreadId>());
  const isActiveThread = (threadId: ThreadId) =>
    activeEnvironmentId === environmentId && activeThreadId === threadId;
  // Fork: questions and approvals stand until answered; failures and limits fall
  // away on their own. Completions have no toast at all.
  const showToast = ({ thread, status, awaitsAnswer }: NotificationState, title: string) => {
    if (awaitsAnswer) standing.current.add(thread.id);
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
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        },
      },
    });
  };
  // Fork: first sight, on load or after a reconnect: a thread already waiting on
  // an answer gets its standing toast back, quietly. The stable id refreshes it.
  const restoreStandingToast = useEffectEvent((entry: NotificationState) => {
    if (!inAppNotificationsEnabled || isActiveThread(entry.thread.id)) return;
    showToast(entry, entry.status === "approval" ? "Approval needed" : "Input needed");
  });

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = useEffectEvent((threadId: ThreadId, kind: ThreadNotificationKind) => {
    const entry = previous.current.get(threadId);
    if (!entry) return;
    const { thread, status } = entry;
    // Fork: a crew session finishing a turn is idle, not done, so it stays quiet.
    if (isSilencedCrewAlert(thread, kind)) return;
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
      !isActiveThread(thread.id) &&
      (entry.awaitsAnswer || onScreen)
    ) {
      showToast(entry, title);
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
      });
      onNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  });
  const gate = useRef<ReturnType<typeof createThreadNotificationGate<ThreadId>>>(null);
  useEffect(() => {
    const created = createThreadNotificationGate<ThreadId>((threadId, kind) =>
      present(threadId, kind),
    );
    gate.current = created;
    return () => {
      created.clear();
      gate.current = null;
      // A new gate has no pending completions, so forget the states they compared against.
      previous.current.clear();
    };
  }, []);

  useEffect(() => {
    const pendingCompletions = gate.current;
    if (!pendingCompletions) return;
    if (threads === null) {
      pendingCompletions.clear();
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const awaiting = new Set<ThreadId>(); // Fork: threads still waiting on an answer
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
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
    previous.current = next;
    // Fork: forgetting a thread while a held command runs re-arms its completion,
    // so a completion that already alerted alerts again when the command ends.
    pendingCompletions.retain(
      new Set([...next].filter(([, state]) => !state.holdsCompletion).map(([id]) => id)),
    );
    for (const [prior, state] of changed) {
      pendingCompletions.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true || state.raw.latestRunSilent === true,
      });
      if (!prior && state.awaitsAnswer) restoreStandingToast(state); // Fork
    }
    // Fork: a standing toast becomes a stale label the moment its thread stops
    // asking: answered anywhere (even while disconnected), turned into a
    // failure or limit, archived, or gone.
    for (const threadId of standing.current) {
      if (awaiting.has(threadId)) continue;
      toastManager.close(attentionToastId(environmentId, threadId));
      standing.current.delete(threadId);
    }
  }, [environmentId, threads]);

  return null;
}
