"use client";

import { attentionPingKey, shouldRingAttentionPing } from "@t3tools/client-runtime/state/attention";
import type { AttentionPing, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isElectron } from "~/env";
import { playAttentionSound } from "~/lib/attentionSound";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { attentionEnvironment } from "~/state/attention";

import { toastManager } from "./ui/toast";

/**
 * Rings once per attention ping, on every environment this client is attached
 * to.
 *
 * Three parts, because no single one is enough. The tone says "now" to someone
 * in the room. The toast says which session is asking, for someone who comes
 * back to a screen. The desktop notification is the only part that survives a
 * minimized window, and it goes to the Action Center where it waits.
 *
 * Mounted at the app root rather than in the sidebar: a ping is about a thread
 * the user is not looking at, so it cannot depend on that thread being open.
 */
function EnvironmentAttentionAlerts({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(attentionEnvironment.latestPing({ environmentId }));
  const ping = query.data as AttentionPing | null;
  const lastRungKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (ping === null) return;
    if (
      !shouldRingAttentionPing({
        ping,
        lastRungKey: lastRungKeyRef.current,
        nowMs: Date.now(),
      })
    ) {
      return;
    }
    lastRungKeyRef.current = attentionPingKey(ping);

    const played = playAttentionSound(ping.sound);
    toastManager.add({
      type: "info",
      title: `${ping.threadTitle} needs you`,
      description: ping.message,
    });
    // The renderer already made the noise, so the OS notification stays silent
    // unless audio was refused, in which case its sound is the only one.
    void (isElectron ? window.desktopBridge?.showAttentionNotification : undefined)?.({
      title: `${ping.threadTitle} needs you`,
      body: ping.message,
      silent: played,
    });
  }, [ping]);

  return null;
}

export function AttentionAlertHost() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentAttentionAlerts
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}
