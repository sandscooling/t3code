"use client";

import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { closeThreadPreviewSessions } from "~/components/preview/closeThreadPreviewSessions";
import { useActivePreviewSessions } from "~/previewStateStore";
import { useThreadShells } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { selectReapableThreadKeys } from "./settledPreviewReaper.logic";

/**
 * Closes settled threads' preview tabs, which otherwise keep running their page until closed (the
 * server only reaps unwatched agent tabs after 30 idle minutes). The store updates optimistically
 * like the close button, so a desktop webview unmounts at once. Reads the server's settled flag,
 * the one the sidebar partitions on, so a tab is reaped only once its thread left the active list.
 */
export function SettledPreviewReaper() {
  const previewByThreadKey = useActivePreviewSessions();
  const shells = useThreadShells();
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

  const previewThreadKeys = Object.entries(previewByThreadKey)
    .filter(([, state]) => Object.keys(state.sessions).length > 0)
    .map(([threadKey]) => threadKey);

  // A tab presented on screen is one the user is looking at, whatever its
  // thread's lifecycle says. Settled state can flip under an open thread when
  // its inactivity window elapses, and a browser disappearing mid-use is worse
  // than the traffic it saves.
  const visibleTabIds = new Set(visibleRuntimeTabIds);
  const onScreenThreadKeys = new Set<string>();
  for (const [threadKey, state] of Object.entries(previewByThreadKey)) {
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) continue;
    for (const tabId of Object.keys(state.sessions)) {
      if (visibleTabIds.has(previewRuntimeTabId(threadRef, state.serverEpoch, tabId))) {
        onScreenThreadKeys.add(threadKey);
        break;
      }
    }
  }

  const shellByThreadKey = new Map<string, EnvironmentThreadShell>();
  for (const shell of shells) {
    shellByThreadKey.set(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell);
  }

  const reapable = selectReapableThreadKeys({
    previewThreadKeys,
    shellByThreadKey,
    onScreenThreadKeys,
  });

  // Belt and braces against re-firing. The optimistic removal inside
  // closeThreadPreviewSessions already takes the thread out of the snapshot
  // this reads, but a restore after a failed close puts it back, and the
  // request may still be outstanding.
  const inFlight = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/react-effect-budget -- Fork: send the close request for each settled thread's previews, once per thread in flight.
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
