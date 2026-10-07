import {
  OrchestrationToolError,
  OrchestratorMcpFailure,
  SessionListInput,
  SessionListResult,
  SessionModelsInput,
  SessionModelsResult,
  SessionProjectsInput,
  SessionProjectsResult,
  SessionReleaseInput,
  SessionReleaseResult,
  SessionRenameInput,
  SessionRenameResult,
  SessionSettleInput,
  SessionSettleResult,
  SessionSpawnInput,
  SessionSpawnResult,
  SessionWakeInput,
  SessionWakeResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SessionMcpService from "./SessionMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  SessionMcpService.SessionMcpService,
];

/** What the session tools fail with, including the access gate's refusal. */
const SessionToolFailure = Schema.Union([OrchestrationToolError, OrchestratorMcpFailure]);

const SessionSpawnTool = Tool.make("session_spawn", {
  description:
    "Start a new agent session as its own top-level thread the user can watch, titled `name`, filed under `group`, and kicked off with `message`. It starts in your own project, or in the one `project` names from session_projects. The session runs in that project's main checkout unless you pass `worktree`: `{ path, branch }` attaches it to a git worktree you already created for that project (checked against git worktree list), and `{ sameAs }` puts it in another session's worktree. T3 never creates, recreates, or deletes these worktrees, and never runs the project's setup script for a spawned session: prepare the directory yourself. It inherits this session's permission mode. It also inherits this session's provider, model, and options unless you pass `instanceId`, `model`, or `options` from session_models, which lets you run the same prompt on several models or hand a review to another provider. Pass `handoff` to replace yourself with the new session: it becomes your sibling, takes over every session you spawned, stays in your worktree, and is pinned in the sidebar in your pinned slot. Pass `standalone` to start a session that is not your child, typically the orchestrator of a new project: settling you never settles it and a handoff of yours never moves it; to detach a session you already spawned, use session_release. Reports what the session runs on, its branch and worktree path, and which sessions a handoff moved. Fails if an open or settled session in that project already has that name.",
  parameters: SessionSpawnInput,
  success: SessionSpawnResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Spawn a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SessionModelsTool = Tool.make("session_models", {
  description:
    "List the providers and models session_spawn can start a session on: each usable provider instance with its models, and each model's options such as reasoning effort with their allowed values and default. The provider with `current: true` is the one you run on. Pass `instanceId` to list one provider only.",
  parameters: SessionModelsInput,
  success: SessionModelsResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SessionProjectsTool = Tool.make("session_projects", {
  description:
    "List the projects on this server that session_spawn and session_list can reach, with their projectId, name and path. The project with `current: true` is the one you run in. Pass a project's name, projectId, or path as `project` to session_spawn or session_list.",
  parameters: SessionProjectsInput,
  success: SessionProjectsResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SessionListTool = Tool.make("session_list", {
  description:
    "List the open sessions in your own project with their threadId, group, project, status, and the branch and worktree path they run in (null on the main checkout), or pass `project` to list another project, or `*` for all of them. Settled sessions are finished work and are left out, so this is what is still in flight, not the whole roster. Status is `running` while a turn is in flight, `held` when messages wait in a queue the server paused after a Stop, a server restart, or a provider failure (nothing sends them until the queue is resumed; session_wake resumes it except after a provider failure, t3_queue_list shows them and t3_queue_cancel drops one), `monitoring` when its last turn ended but left a watch or background command going (it will speak again on its own), and `ready` when idle; session_wake reaches all four. The row with `self: true` is you, so its threadId is the address another session can wake you back on, from any project.",
  parameters: SessionListInput,
  success: SessionListResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SessionWakeTool = Tool.make("session_wake", {
  description:
    "Send a message to an existing session: by name in your own project, or by the threadId session_list reports in any project. An idle session starts a turn, opening its provider process if none is running; a settled one reopens; a busy one gets the message inside its running turn where its provider allows that, or queued right behind it, and always queued while it has a question or approval open. A held one (see session_list) has its paused queue resumed, and the message is queued behind the ones already waiting there, never steered, even while a turn runs. If the queue was held because the provider failed, the wake is refused with `queue-held` instead, since resuming would send the next message to the failing provider: ask the user to resume the queue in the app once the provider works, or drop messages with t3_queue_cancel (t3_queue_list shows them). `delivery` says which happened. The recipient sees the message as sent by you. Use the threadId for a session in another project, or one whose title has spaces. Fails if no open or settled session matches, or more than one shares that name.",
  parameters: SessionWakeInput,
  success: SessionWakeResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Wake a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SessionSettleTool = Tool.make("session_settle", {
  description:
    "Settle a finished session, clearing it out of the inbox: by name in your own project, or by the threadId session_list reports in any project. The sessions it spawned settle with it (`settledWith`), however it is settled, from here or the sidebar. Any of them with a turn running or queued, or an approval pending, stays open (`leftOpen`). Settling again is harmless. Fails while that session itself has a turn running or queued, or an approval pending; stop it or answer it first. A question it asked that can be answered by message is dismissed. You cannot settle yourself, because your own turn is running.",
  parameters: SessionSettleInput,
  success: SessionSettleResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Settle a session")
  .annotate(Tool.Readonly, false)
  // Reversible: the user unsettles the row, and any message re-opens it.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SessionRenameTool = Tool.make("session_rename", {
  description:
    "Rename a session: by name in your own project, or by the threadId session_list reports in any project. You can rename yourself. The new name follows session_spawn's rules and must not be held by any other open or settled session in that project; to reuse a settled session's name, rename that session first. After a handoff, this is how a successor takes the old name: settle the old orchestrator, rename it, then rename yourself. Hand other sessions your threadId, which never changes.",
  parameters: SessionRenameInput,
  success: SessionRenameResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Rename a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SessionReleaseTool = Tool.make("session_release", {
  description:
    "Detach a session you spawned so it no longer has a spawner, as if spawned with `standalone`: by name in your own project, or by the threadId session_list reports in any project. Afterwards settling you does not settle it, and a handoff of yours does not move it. Use it when a session you started, such as a new project's orchestrator, should outlive you. Nothing else changes: it keeps its group, stays open or settled as it was, and keeps running. Works on settled sessions too. Fails if you are not its spawner, naming the session that is, or if it has none.",
  parameters: SessionReleaseInput,
  success: SessionReleaseResult,
  failure: SessionToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Release a session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const OrchestrationToolkit = Toolkit.make(
  SessionSpawnTool,
  SessionModelsTool,
  SessionProjectsTool,
  SessionListTool,
  SessionWakeTool,
  SessionSettleTool,
  SessionRenameTool,
  SessionReleaseTool,
);
