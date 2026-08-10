"use client";

import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { closeThreadPreviewSessions } from "~/components/preview/closeThreadPreviewSessions";
import { useClientSettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useActivePreviewSessions } from "~/previewStateStore";
import { useThreadShells } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { selectReapableThreadKeys } from "./settledPreviewReaper.logic";

/**
 * Closes browser preview sessions belonging to settled threads.
 *
 * ElectronBrowserHost mounts every open session for every thread, and
 * hostedBrowserWebviewStyle keeps those guests CSS-visible while parked
 * offscreen so background automation keeps working. Nothing throttles them, so
 * a settled thread's tab keeps running its page: timers, polling, sockets. The
 * server owns the session records, so the close goes there, and the local
 * store is updated optimistically alongside it the way the close button does:
 * the host renders from that store, so dropping the session there is what
 * stops the webview and lets desktopTabLifetime tear the guest down through
 * the path it already uses.
 *
 * Runs on the minute-quantized clock the sidebar partitions on, so a tab is
 * only reaped on the tick that moves its thread out of the active list.
 */
export function SettledPreviewReaper() {
  const previewByThreadKey = useActivePreviewSessions();
  const shells = useThreadShells();
  const now = useNowMinute();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const closePreview = useAtomCommand(previewEnvironment.close);

  // Only visibility is read from the surface store. Subscribing to the whole
  // presentation would re-run this on every rect change, which fires on
  // resize and layout, not on the state this actually depends on.
  const visibleRuntimeTabIds = useBrowserSurfaceStore(
    useShallow((state) =>
      Object.entries(state.byTabId)
        .filter(([, presentation]) => presentation.visible)
        .map(([runtimeTabId]) => runtimeTabId)
        .sort(),
    ),
  );

  const previewThreadKeys = useMemo(
    () =>
      Object.entries(previewByThreadKey)
        .filter(([, state]) => Object.keys(state.sessions).length > 0)
        .map(([threadKey]) => threadKey),
    [previewByThreadKey],
  );

  // A tab presented on screen is one the user is looking at, whatever its
  // thread's lifecycle says. Settled state can flip under an open thread when
  // its inactivity window elapses, and a browser disappearing mid-use is worse
  // than the traffic it saves.
  const onScreenThreadKeys = useMemo(() => {
    const visible = new Set(visibleRuntimeTabIds);
    const keys = new Set<string>();
    for (const [threadKey, state] of Object.entries(previewByThreadKey)) {
      const threadRef = parseScopedThreadKey(threadKey);
      if (!threadRef) continue;
      for (const tabId of Object.keys(state.sessions)) {
        if (visible.has(previewRuntimeTabId(threadRef, state.serverEpoch, tabId))) {
          keys.add(threadKey);
          break;
        }
      }
    }
    return keys;
  }, [previewByThreadKey, visibleRuntimeTabIds]);

  const shellByThreadKey = useMemo(() => {
    const map = new Map<string, OrchestrationThreadShell>();
    for (const shell of shells) {
      map.set(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell);
    }
    return map;
  }, [shells]);

  const reapable = useMemo(
    () =>
      selectReapableThreadKeys({
        previewThreadKeys,
        shellByThreadKey,
        onScreenThreadKeys,
        now,
        autoSettleAfterDays,
      }),
    [autoSettleAfterDays, now, onScreenThreadKeys, previewThreadKeys, shellByThreadKey],
  );

  // Belt and braces against re-firing. The optimistic removal inside
  // closeThreadPreviewSessions already takes the thread out of the snapshot
  // this reads, but a restore after a failed close puts it back, and the
  // request may still be outstanding.
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    for (const threadKey of reapable) {
      if (inFlight.current.has(threadKey)) continue;
      const threadRef = parseScopedThreadKey(threadKey);
      if (!threadRef) continue;
      inFlight.current.add(threadKey);
      void closeThreadPreviewSessions({ closePreview, threadRef })
        .catch(() => undefined)
        .finally(() => {
          inFlight.current.delete(threadKey);
        });
    }
  }, [closePreview, reapable]);

  return null;
}
