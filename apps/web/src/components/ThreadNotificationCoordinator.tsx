import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { isSilencedCrewAlert } from "@t3tools/shared/crewSession"; // Fork: quiet crew completions
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
// Fork: no completion toast, so no CircleCheckIcon.
import { CircleAlertIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
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
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
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

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(
    new Map<ThreadId, { attention: string | null; completion: number | null }>(),
  );
  // Fork: threads with a standing answer toast open. Unlike `previous` it
  // survives a disconnect, so an answer that landed meanwhile still clears it.
  const standing = useRef(new Set<ThreadId>());

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, { attention: string | null; completion: number | null }>();
    const awaiting = new Set<ThreadId>(); // Fork: threads still waiting on an answer
    for (const rawThread of shell.snapshot.value.threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const thread = presentThreadShell(environmentId, rawThread);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const prior = previous.current.get(thread.id);
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      // Commands left running (a dev server) read as ready; subagents, monitors,
      // and commands someone waits for wait. Waiting re-arms the alert, so a
      // completion that already alerted alerts again when the held work ends.
      const completion =
        status === "waiting"
          ? null
          : status === "ready" &&
              thread.latestRun?.status === "completed" &&
              Number.isFinite(completedAt)
            ? completedAt
            : (prior?.completion ?? null);
      next.set(thread.id, { attention, completion });
      // Fork: only threads that want the reader get a toast. Questions and
      // approvals stand until answered; failures and limits fall away on their
      // own. Completions have no toast at all, only their sound and background
      // system popup.
      if (thread.archivedAt !== null) continue;
      const awaitsAnswer = status === "input" || status === "approval";
      if (awaitsAnswer) awaiting.add(thread.id);
      const isActiveThread = activeEnvironmentId === environmentId && activeThreadId === thread.id;
      const showToast = (title: string) => {
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
      if (!prior) {
        // Fork: first sight, on load or after a reconnect: a thread already
        // waiting on an answer gets its standing toast back, quietly. The stable
        // id means an existing toast is refreshed rather than duplicated.
        if (awaitsAnswer && inAppNotificationsEnabled && !isActiveThread) {
          showToast(status === "approval" ? "Approval needed" : "Input needed");
        }
        continue;
      }
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      // Fork: a crew session finishing a turn is idle, not done, so it stays quiet.
      if (isSilencedCrewAlert(thread, kind)) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      const onScreen = document.visibilityState === "visible" && document.hasFocus();
      // Fork: a question must still be waiting when the reader comes back, so
      // its toast does not depend on focus; the app can think it is unfocused
      // while the reader is looking at it (a browser preview or dictation
      // holding focus). A background question still gets its system popup below.
      if (
        kind === "input" &&
        inAppNotificationsEnabled &&
        !isActiveThread &&
        (awaitsAnswer || onScreen)
      ) {
        showToast(title);
        if (onScreen) continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        onScreen ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: `${environmentId}:${thread.id}`,
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    // Fork: a standing toast becomes a stale label the moment its thread stops
    // asking: answered anywhere (even while disconnected), turned into a
    // failure or limit, archived, or gone.
    for (const threadId of standing.current) {
      if (awaiting.has(threadId)) continue;
      toastManager.close(attentionToastId(environmentId, threadId));
      standing.current.delete(threadId);
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onNotification,
    shell,
  ]);

  return null;
}
