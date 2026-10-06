"use client";

import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";

import { useActivePreviewSessions } from "~/previewStateStore";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import {
  applyEnvironmentPreviewEvent,
  previewThreadRefsIn,
  relistPreviewThread,
} from "./previewSessionsFeed.logic";

/**
 * Fork: feeds every thread's preview sessions into previewStateStore, one
 * environment-wide event subscription per connected environment. See
 * previewSessionsFeed.logic.ts for why the routed thread's feed is not enough.
 */
export function PreviewSessionsFeed() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => (
          <EnvironmentPreviewSessionsFeed
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ))}
    </>
  );
}

/** Mounts per connection, so a reconnect remounts it and lists known threads again. */
function EnvironmentPreviewSessionsFeed(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
    refresh: true,
  });
  // Read once per connection, not as a dependency: re-listing on every
  // session change would turn each event into a list request.
  const activeSessions = useActivePreviewSessions();
  const activeSessionsRef = useRef(activeSessions);
  useEffect(() => {
    activeSessionsRef.current = activeSessions;
  }, [activeSessions]);

  useEffect(() => {
    const relist = (threadRef: Parameters<typeof relistPreviewThread>[0]) => {
      void relistPreviewThread(threadRef, listPreviews).catch(() => undefined);
    };
    // The event stream does not replay what happened while disconnected.
    for (const threadRef of previewThreadRefsIn(
      environmentId,
      Object.keys(activeSessionsRef.current),
    )) {
      relist(threadRef);
    }
    const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
    // Only new events: the cached latest one may be from before this connection.
    const unsubscribe = registry.subscribe(eventsAtom, (result) => {
      if (AsyncResult.isSuccess(result)) {
        applyEnvironmentPreviewEvent(environmentId, result.value, relist);
      }
    });
    // A plain subscribe never builds the atom, so the stream needs a mount too.
    const unmount = registry.mount(eventsAtom);
    return () => {
      unsubscribe();
      unmount();
    };
  }, [environmentId, listPreviews, registry]);

  return null;
}
