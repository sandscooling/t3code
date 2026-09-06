import {
  OrchestrationToolError,
  SessionListInput,
  SessionListResult,
  SessionSettleInput,
  SessionSettleResult,
  SessionSpawnInput,
  SessionSpawnResult,
  SessionWakeInput,
  SessionWakeResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  Crypto.Crypto,
];

export const SessionSpawnTool = Tool.make("session_spawn", {
  description:
    "Start a new agent session in this project as its own thread, titled `name`, filed under `group`, and kicked off with `message`. The session runs in the project directory on the current checkout and inherits this session's model and permission mode. Fails if an open session already has that name.",
  parameters: SessionSpawnInput,
  success: SessionSpawnResult,
  failure: OrchestrationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const SessionListTool = Tool.make("session_list", {
  description:
    "List the open sessions in this project with their threadId, group and live status. Settled sessions are finished work and are left out, so this is what is still in flight, not the whole roster. Status is `stopped` when a session has no running provider process; pass such a session's name or threadId to session_wake to bring it back. The row with `self: true` is you, so its threadId is the address another session can wake you back on.",
  parameters: SessionListInput,
  success: SessionListResult,
  failure: OrchestrationToolError,
  dependencies,
})
  .annotate(Tool.Title, "List sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SessionWakeTool = Tool.make("session_wake", {
  description:
    "Send a message to an existing session in this project by name, or by the threadId session_list reports, starting a turn on it. A stopped session gets its provider process back under the same name. Use the threadId to reach a session whose title has spaces. Fails if no open session matches, or more than one shares that name.",
  parameters: SessionWakeInput,
  success: SessionWakeResult,
  failure: OrchestrationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wake a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const SessionSettleTool = Tool.make("session_settle", {
  description:
    "Settle a finished session in this project by name, or by the threadId session_list reports, clearing it out of the inbox. Any sessions it spawned settle with it. Settling again is harmless. Fails while that session is running, waiting on the user, or holding a queued turn; stop it or answer it first. You cannot settle yourself, because your own turn is running.",
  parameters: SessionSettleInput,
  success: SessionSettleResult,
  failure: OrchestrationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Settle a session")
  .annotate(Tool.Readonly, false)
  // Reversible: the user unsettles the row, and any message re-opens it.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OrchestrationToolkit = Toolkit.make(
  SessionSpawnTool,
  SessionListTool,
  SessionWakeTool,
  SessionSettleTool,
);
