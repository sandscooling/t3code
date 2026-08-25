import {
  OrchestrationToolError,
  SessionListInput,
  SessionListResult,
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
    "List the open sessions in this project with their group and live status. Status is `stopped` when a session has no running provider process; pass such a session's name to session_wake to bring it back.",
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
    "Send a message to an existing session in this project by name, starting a turn on it. A stopped session gets its provider process back under the same name. Fails if no open session has that name, or more than one does.",
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

export const OrchestrationToolkit = Toolkit.make(
  SessionSpawnTool,
  SessionListTool,
  SessionWakeTool,
);
