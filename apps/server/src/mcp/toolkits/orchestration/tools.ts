import {
  OrchestrationToolError,
  SessionListInput,
  SessionListResult,
  SessionModelsInput,
  SessionModelsResult,
  SessionProjectsInput,
  SessionProjectsResult,
  SessionRenameInput,
  SessionRenameResult,
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
    "Start a new agent session as its own thread, titled `name`, filed under `group`, and kicked off with `message`. It starts in your own project, or in the one `project` names from session_projects. The session runs in that project's directory on its current checkout and inherits this session's permission mode. It also inherits this session's provider, model, and options unless you pass `instanceId`, `model`, or `options` from session_models, which lets you run the same prompt on several models or hand a review to another provider. Pass `handoff` to replace yourself with the new session: it becomes your sibling, takes over every session you spawned, and is pinned in the sidebar in your pinned slot. Reports what the session runs on, and which sessions a handoff moved. Fails if an open session already has that name.",
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

export const SessionProjectsTool = Tool.make("session_projects", {
  description:
    "List the projects on this server that session_spawn and session_list can reach, with their projectId, name and path. The project with `current: true` is the one you run in. Pass a project's name, projectId, or path as `project` to session_spawn or session_list.",
  parameters: SessionProjectsInput,
  success: SessionProjectsResult,
  failure: OrchestrationToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SessionListTool = Tool.make("session_list", {
  description:
    "List the open sessions in your own project with their threadId, group, project and live status, or pass `project` to list another project, or `*` for all of them. Settled sessions are finished work and are left out, so this is what is still in flight, not the whole roster. Status is `stopped` when a session has no running provider process; pass such a session's name or threadId to session_wake to bring it back. The row with `self: true` is you, so its threadId is the address another session can wake you back on, from any project.",
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
    "Send a message to an existing session, starting a turn on it: by name in your own project, or by the threadId session_list reports in any project. A stopped session gets its provider process back under the same name. Use the threadId for a session in another project, or one whose title has spaces. Fails if no open session matches, or more than one shares that name.",
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
    "Settle a finished session, clearing it out of the inbox: by name in your own project, or by the threadId session_list reports in any project. Any sessions it spawned settle with it. Settling again is harmless. Fails while that session is running, waiting on the user, or holding a queued turn; stop it or answer it first. You cannot settle yourself, because your own turn is running.",
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

export const SessionRenameTool = Tool.make("session_rename", {
  description:
    "Rename a session: by name in your own project, or by the threadId session_list reports in any project. You can rename yourself. The new name follows session_spawn's rules and must not be held by any other open or settled session in that project; to reuse a settled session's name, rename that session first. After a handoff, this is how a successor takes the old name: settle the old orchestrator, rename it, then rename yourself. The title changes at once, but a Claude session's peer name only follows the next time its process starts, so hand other sessions your threadId, which never changes.",
  parameters: SessionRenameInput,
  success: SessionRenameResult,
  failure: OrchestrationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Rename a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OrchestrationToolkit = Toolkit.make(
  SessionSpawnTool,
  SessionModelsTool,
  SessionProjectsTool,
  SessionListTool,
  SessionWakeTool,
  SessionSettleTool,
  SessionRenameTool,
);
