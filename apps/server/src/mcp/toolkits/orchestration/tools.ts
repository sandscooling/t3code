import {
  OrchestrationToolError,
  SessionNotifyInput,
  SessionNotifyResult,
  SessionListInput,
  SessionListResult,
  SessionModelsInput,
  SessionModelsResult,
  SessionSettleInput,
  SessionSettleResult,
  SessionSpawnInput,
  SessionSpawnResult,
  SessionWakeInput,
  SessionWakeResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as AttentionBus from "../../../attention/AttentionBus.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  Crypto.Crypto,
];

export const SessionSpawnTool = Tool.make("session_spawn", {
  description:
    "Start a new agent session in this project as its own thread, titled `name`, filed under `group`, and kicked off with `message`. The session runs in the project directory on the current checkout and inherits this session's permission mode. It also inherits this session's provider, model, and options unless you pass `instanceId`, `model`, or `options` from session_models, which lets you run the same prompt on several models or hand a review to another provider. Reports what the session runs on. Fails if an open session already has that name.",
  parameters: SessionSpawnInput,
  success: SessionSpawnResult,
  failure: OrchestrationToolError,
  dependencies: [...dependencies, ProviderRegistry],
})
  .annotate(Tool.Title, "Spawn a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const SessionModelsTool = Tool.make("session_models", {
  description:
    "List the providers and models session_spawn can start a session on: each usable provider instance with its models, and each model's options such as reasoning effort with their allowed values and default. The provider with `current: true` is the one you run on. Pass `instanceId` to list one provider only.",
  parameters: SessionModelsInput,
  success: SessionModelsResult,
  failure: OrchestrationToolError,
  dependencies: [...dependencies, ProviderRegistry],
})
  .annotate(Tool.Title, "List models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

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

export const SessionNotifyTool = Tool.make("session_notify", {
  description:
    "Ring the user in person: play a sound and raise a notification on every client attached to this server. For when you need an answer and the user may be away from the screen. Say what you need in one line; the message is what they read. Reports how many clients heard it, and zero means nobody was connected. Use it sparingly, since it interrupts a person rather than an agent.",
  parameters: SessionNotifyInput,
  success: SessionNotifyResult,
  failure: OrchestrationToolError,
  dependencies: [...dependencies, AttentionBus.AttentionBus, ServerSettings.ServerSettingsService],
})
  .annotate(Tool.Title, "Notify the user")
  .annotate(Tool.Readonly, false)
  // Nothing is written and nothing is undone: it makes a noise.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const OrchestrationToolkit = Toolkit.make(
  SessionSpawnTool,
  SessionModelsTool,
  SessionListTool,
  SessionWakeTool,
  SessionSettleTool,
  SessionNotifyTool,
);
