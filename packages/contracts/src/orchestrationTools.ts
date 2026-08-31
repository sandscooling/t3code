import * as Schema from "effect/Schema";

import { OrchestrationSessionStatus } from "./orchestration.ts";

/**
 * Contracts for the `session_*` MCP tools an agent uses to start, list, and
 * wake other sessions in its own project. Sessions are real threads, so they
 * show in the sidebar, checkpoint on their own, and outlive the turn that
 * created them. What the sessions are for (tickets, roles, review) is the
 * calling agent's business; nothing here knows about it.
 */

/**
 * Names double as the Claude peer name, so they are kept to what a shell and
 * a registry file both accept: no spaces, no path separators.
 */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SessionName = Schema.String.check(Schema.isPattern(SESSION_NAME_PATTERN));

export const SessionSpawnInput = Schema.Struct({
  name: SessionName.annotate({
    description:
      "Title of the new session, unique among the project's open sessions. Letters, digits, dot, underscore, hyphen; 1 to 64 characters. Becomes the session's peer name.",
  }),
  group: SessionName.annotate({
    description:
      "Group the session belongs to, e.g. a ticket id. Sessions sharing a group render together in the sidebar. Same character rules as name.",
  }),
  message: Schema.String.annotate({
    description:
      "The opening message for the new session. It starts the session's first turn, so keep it to what the session should do first.",
  }),
});
export type SessionSpawnInput = typeof SessionSpawnInput.Type;

export const SessionSpawnResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  group: Schema.String,
});
export type SessionSpawnResult = typeof SessionSpawnResult.Type;

export const SessionListInput = Schema.Struct({
  group: Schema.optional(
    SessionName.annotate({
      description:
        "Only list sessions in this group. Omit to list every open session in the project.",
    }),
  ),
});
export type SessionListInput = typeof SessionListInput.Type;

export const SessionSummary = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  group: Schema.NullOr(Schema.String),
  /** `stopped` when the session has no live provider process. */
  status: OrchestrationSessionStatus,
  /** True on the calling session's own row, so it can pass its threadId as a reply address. */
  self: Schema.Boolean,
});
export type SessionSummary = typeof SessionSummary.Type;

export const SessionListResult = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
});
export type SessionListResult = typeof SessionListResult.Type;

export const SessionWakeInput = Schema.Struct({
  name: SessionName.annotate({
    description:
      "Title of an existing session in this project to send a turn to, or the threadId session_list reports for it. Use the threadId when the title has spaces.",
  }),
  message: Schema.String.annotate({
    description:
      "The message to send. Starts a turn on that session, which also restarts its provider process if it had stopped.",
  }),
});
export type SessionWakeInput = typeof SessionWakeInput.Type;

export const SessionWakeResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
});
export type SessionWakeResult = typeof SessionWakeResult.Type;

export const OrchestrationToolErrorReason = Schema.Literals([
  "capability-unavailable",
  "invalid-name",
  "thread-not-found",
  "ambiguous-name",
  "already-exists",
  "dispatch-failed",
]);
export type OrchestrationToolErrorReason = typeof OrchestrationToolErrorReason.Type;

export class OrchestrationToolError extends Schema.TaggedErrorClass<OrchestrationToolError>()(
  "OrchestrationToolError",
  {
    reason: OrchestrationToolErrorReason,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason;
  }
}
