import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

/**
 * Contracts for the `session_*` MCP tools an agent uses to start, list, wake,
 * settle, and release other sessions in any project on its server. Sessions are real threads, so they
 * show in the sidebar, checkpoint on their own, and outlive the turn that
 * created them. What the sessions are for (tickets, roles, review) is the
 * calling agent's business; nothing here knows about it.
 */

/**
 * Names are addresses another session types into session_wake, so they are
 * kept to one word: no spaces, no path separators.
 */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SessionName = Schema.String.check(Schema.isPattern(SESSION_NAME_PATTERN));

/**
 * Session names only reach the caller's own project; a threadId reaches any
 * project. v2 threadIds carry colons, so this is not held to the name pattern.
 */
const SessionRef = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "Name of a session in your own project, or the threadId session_list reports for a session in any project. Use the threadId for a session in another project, or one whose title has spaces.",
});

const ProjectRef = Schema.String;

const SessionModelOptionValue = Schema.Union([Schema.String, Schema.Boolean]);
const SessionModelOptionSelection = Schema.Struct({
  id: Schema.String,
  value: SessionModelOptionValue,
});

/**
 * A worktree an outside tool created. T3 only records it: it never creates,
 * recreates, or deletes these.
 */
const SessionWorktree = Schema.Union([
  Schema.Struct({
    path: Schema.String.annotate({
      description:
        "Absolute path of a git worktree you already created for the target project, e.g. with `git worktree add`. It must not be the project's own checkout.",
    }),
    branch: Schema.String.annotate({
      description:
        "Branch checked out in that worktree. The spawn is refused if git reports a different one.",
    }),
  }).annotate({
    description:
      "Attach to an existing worktree by path. Use this for the first session of a lane.",
  }),
  Schema.Struct({
    sameAs: SessionRef,
  }).annotate({
    description:
      "Run in the same worktree as another session, copying its branch and path. A session on the main checkout passes that on too.",
  }),
]).annotate({
  description:
    "Existing git worktree the session runs in: `{ path, branch }` for one you created, or `{ sameAs }` to share another session's. T3 never creates, recreates, or deletes these worktrees. Omit to run on the project's main checkout, or, with `handoff`, in your own worktree.",
});

/** Defaults for an idle handoff: the prompt cache lives about an hour. */
export const IDLE_HANDOFF_DEFAULT_AFTER_MINUTES = 50;
export const IDLE_HANDOFF_DEFAULT_MIN_TOKENS = 200_000;

const IdleHandoffAfterMinutes = PositiveInt.check(Schema.isLessThanOrEqualTo(24 * 60)).annotate({
  description: `Minutes the session must sit idle before the reminder is posted, 1 to 1440. Defaults to ${IDLE_HANDOFF_DEFAULT_AFTER_MINUTES}.`,
});
const IdleHandoffMinTokens = NonNegativeInt.annotate({
  description: `Context size, in tokens, the session's last turn must have reached for the reminder to be posted. Defaults to ${IDLE_HANDOFF_DEFAULT_MIN_TOKENS}.`,
});

/** An idle handoff in force on a session, with its defaults filled in. */
export const SessionIdleHandoffSetting = Schema.Struct({
  afterMinutes: PositiveInt,
  minTokens: NonNegativeInt,
});
export type SessionIdleHandoffSetting = typeof SessionIdleHandoffSetting.Type;

const SessionIdleHandoffOptions = Schema.Struct({
  afterMinutes: Schema.optional(IdleHandoffAfterMinutes),
  minTokens: Schema.optional(IdleHandoffMinTokens),
});

export const SessionSpawnInput = Schema.Struct({
  name: SessionName.annotate({
    description:
      "Title of the new session, unique among the target project's open and settled sessions. Letters, digits, dot, underscore, hyphen; 1 to 64 characters.",
  }),
  project: Schema.optional(
    ProjectRef.annotate({
      description:
        "Project to start the session in, by the name, projectId, or path session_projects reports. Omit to use your own project.",
    }),
  ),
  group: SessionName.annotate({
    description:
      "Group the session belongs to, e.g. a ticket id. Sessions sharing a group render together in the sidebar. Same character rules as name.",
  }),
  message: Schema.String.annotate({
    description:
      "The opening message for the new session. It starts the session's first turn, so keep it to what the session should do first.",
  }),
  instanceId: Schema.optional(
    Schema.String.annotate({
      description:
        "Provider instance to run the session on, as session_models reports it (e.g. `codex`). Omit to use your own. A different provider with no `model` gets that provider's default model.",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "Model slug from session_models for the chosen provider. Omit to keep your own model, or the provider default when `instanceId` names a different provider.",
    }),
  ),
  options: Schema.optional(
    Schema.Array(SessionModelOptionSelection).annotate({
      description:
        "Model options such as reasoning effort, as `{ id, value }` pairs from the model's options in session_models. Options you leave out take the model's defaults. Omit entirely to keep your own options when the model is unchanged.",
    }),
  ),
  handoff: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Hand your work to the new session, to replace yourself when your context has grown too long. The new session becomes your sibling instead of your child, and every session you spawned moves to it, so settling you afterwards leaves them open. It stays in your worktree unless you pass `worktree`. Put everything it needs to continue in `message`. To finish, settle yourself with session_settle, which takes effect when your turn ends.",
    }),
  ),
  worktree: Schema.optional(SessionWorktree),
  standalone: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Start the session with no spawner, like a thread the user made, instead of as your child. Settling you never settles it, and a handoff of yours never moves it. Use this for the orchestrator of a new project you are setting up, often with `project`. Cannot be combined with `handoff`.",
    }),
  ),
  idleHandoff: Schema.optional(
    SessionIdleHandoffOptions.annotate({
      description:
        "Give the new session an idle handoff from birth, as if it had called session_idle_handoff on itself; `{}` takes the defaults. With `handoff` and no `idleHandoff`, the new session takes over yours, if you have one.",
    }),
  ),
});
export type SessionSpawnInput = typeof SessionSpawnInput.Type;

export const SessionSpawnResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  group: Schema.String,
  projectId: Schema.String,
  /** What the session actually runs on, after defaults were filled in. */
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.Array(SessionModelOptionSelection),
  /** Names of the sessions a handoff moved to the new session; empty otherwise. */
  adopted: Schema.Array(Schema.String),
  /** The worktree the session runs in; both null on the project's main checkout. */
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  /** The new session's idle handoff, null when it has none. */
  idleHandoff: Schema.NullOr(SessionIdleHandoffSetting),
});
export type SessionSpawnResult = typeof SessionSpawnResult.Type;

export const SessionModelsInput = Schema.Struct({
  instanceId: Schema.optional(
    Schema.String.annotate({
      description:
        "Only list this provider instance's models. Omit to list every usable provider; some carry hundreds of models.",
    }),
  ),
});
export type SessionModelsInput = typeof SessionModelsInput.Type;

export const SessionModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["select", "boolean"]),
  /** Allowed values of a `select` option. */
  choices: Schema.optional(Schema.Array(Schema.String)),
  default: Schema.optional(SessionModelOptionValue),
});
export type SessionModelOption = typeof SessionModelOption.Type;

export const SessionModelsResult = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      driver: Schema.String,
      displayName: Schema.String,
      status: Schema.String,
      /** True on the provider the calling session runs on. */
      current: Schema.Boolean,
      models: Schema.Array(
        Schema.Struct({
          slug: Schema.String,
          name: Schema.String,
          isDefault: Schema.Boolean,
          options: Schema.Array(SessionModelOption),
        }),
      ),
    }),
  ),
});
export type SessionModelsResult = typeof SessionModelsResult.Type;

export const SessionProjectsInput = Schema.Struct({
  match: Schema.optional(
    Schema.String.annotate({
      description:
        "Only list projects whose name or path contains this text, ignoring case. Omit to list every project.",
    }),
  ),
});
export type SessionProjectsInput = typeof SessionProjectsInput.Type;

export const SessionProjectsResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      name: Schema.String,
      path: Schema.String,
      /** True on the project the calling session belongs to. */
      current: Schema.Boolean,
    }),
  ),
});
export type SessionProjectsResult = typeof SessionProjectsResult.Type;

/** Lists every project at once, instead of one project. */
export const ALL_PROJECTS = "*";

export const SessionListInput = Schema.Struct({
  group: Schema.optional(
    SessionName.annotate({
      description:
        "Only list sessions in this group. Omit to list every open session in the project. Settled sessions never appear either way.",
    }),
  ),
  project: Schema.optional(
    ProjectRef.annotate({
      description:
        "Project to list, by the name, projectId, or path session_projects reports, or `*` for every project. Omit to list your own project.",
    }),
  ),
});
export type SessionListInput = typeof SessionListInput.Type;

/**
 * `running` while a turn is in flight (preparing, queued, starting, running,
 * or finishing up), `held` when no turn runs but messages wait in a queue the
 * server paused after a Stop, a server restart, or a provider failure (nothing
 * sends them until the queue is resumed), `monitoring`
 * when the last turn ended but left background work such as a watch or a
 * background command going, `ready` otherwise. session_wake reaches every one
 * of them.
 */
export const SessionStatus = Schema.Literals(["running", "held", "monitoring", "ready"]);
export type SessionStatus = typeof SessionStatus.Type;

export const SessionSummary = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  group: Schema.NullOr(Schema.String),
  projectId: Schema.String,
  /** The project's name, as session_projects reports it. */
  project: Schema.String,
  status: SessionStatus,
  /** True on the calling session's own row, so it can pass its threadId as a reply address. */
  self: Schema.Boolean,
  /** The worktree the session runs in; both null on the project's main checkout. */
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  /** The idle handoff set on the session (session_idle_handoff), null when none is. */
  idleHandoff: Schema.NullOr(SessionIdleHandoffSetting),
});
export type SessionSummary = typeof SessionSummary.Type;

export const SessionListResult = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
});
export type SessionListResult = typeof SessionListResult.Type;

export const SessionWakeInput = Schema.Struct({
  name: SessionRef,
  message: Schema.String.annotate({
    description:
      "The message to send. On an idle session it starts a turn, opening its provider process if none is running; on a busy one it is delivered into the running turn, or queued behind it. On a session with a paused queue (after a Stop or a server restart) it resumes that queue and is queued behind the messages already there, even while a turn runs; after a provider failure it is refused instead.",
  }),
});
export type SessionWakeInput = typeof SessionWakeInput.Type;

export const SessionWakeResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  /** `started` a new turn, was `steered` into the running turn, or was `queued` behind it. */
  delivery: Schema.Literals(["started", "steered", "queued"]),
});
export type SessionWakeResult = typeof SessionWakeResult.Type;

export const SessionSettleInput = Schema.Struct({
  name: SessionRef,
});
export type SessionSettleInput = typeof SessionSettleInput.Type;

export const SessionSettleResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  /** Names of the sessions it spawned that settled with it. */
  settledWith: Schema.Array(Schema.String),
  /**
   * Names of the sessions it spawned that are still open: the settle refused
   * them because they still need attention, or failed.
   */
  leftOpen: Schema.Array(Schema.String),
  /**
   * Set when a session settled itself: its own turn is running, so it settles
   * once that turn completes, and the sessions it spawned settle with it then.
   * `settledWith` and `leftOpen` are empty, since nothing has settled yet.
   */
  settlesWhenTurnEnds: Schema.optional(Schema.Literal(true)),
});
export type SessionSettleResult = typeof SessionSettleResult.Type;

export const SessionRenameInput = Schema.Struct({
  session: SessionRef,
  name: SessionName.annotate({
    description:
      "The new name. Same rules as session_spawn: letters, digits, dot, underscore, hyphen; 1 to 64 characters. No other open or settled session in that project may hold it.",
  }),
});
export type SessionRenameInput = typeof SessionRenameInput.Type;

export const SessionRenameResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  previousName: Schema.String,
});
export type SessionRenameResult = typeof SessionRenameResult.Type;

export const SessionReleaseInput = Schema.Struct({
  name: SessionRef,
});
export type SessionReleaseInput = typeof SessionReleaseInput.Type;

export const SessionReleaseResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
});
export type SessionReleaseResult = typeof SessionReleaseResult.Type;

export const SessionIdleHandoffInput = Schema.Struct({
  ...SessionIdleHandoffOptions.fields,
  enabled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Pass false to turn your idle handoff off; the other fields are then ignored. Omit, or pass true, to turn it on or change it.",
    }),
  ),
});
export type SessionIdleHandoffInput = typeof SessionIdleHandoffInput.Type;

export const SessionIdleHandoffResult = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  /** The idle handoff now in force, null once it is off. */
  idleHandoff: Schema.NullOr(SessionIdleHandoffSetting),
});
export type SessionIdleHandoffResult = typeof SessionIdleHandoffResult.Type;

/**
 * When an armed idle handoff fires if the thread stays idle, for the sidebar
 * hover card. Asked only while the card is open, so nothing streams per thread.
 */
export const SESSION_IDLE_HANDOFF_DUE_METHOD = "fork.sessionIdleHandoff.due";

export const SessionIdleHandoffDueInput = Schema.Struct({ threadId: ThreadId });
export type SessionIdleHandoffDueInput = typeof SessionIdleHandoffDueInput.Type;

/** Null unless the handoff is armed: opted in, last turn at the token line, thread idle. */
export const SessionIdleHandoffDueResult = Schema.NullOr(Schema.Struct({ dueAt: IsoDateTime }));
export type SessionIdleHandoffDueResult = typeof SessionIdleHandoffDueResult.Type;

export class SessionIdleHandoffDueError extends Schema.TaggedError<SessionIdleHandoffDueError>()(
  "SessionIdleHandoffDueError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const WsSessionIdleHandoffDueRpc = Rpc.make(SESSION_IDLE_HANDOFF_DUE_METHOD, {
  payload: SessionIdleHandoffDueInput,
  success: SessionIdleHandoffDueResult,
  error: Schema.Union([SessionIdleHandoffDueError, EnvironmentAuthorizationError]),
});

export const OrchestrationToolErrorReason = Schema.Literals([
  "capability-unavailable",
  "invalid-name",
  "thread-not-found",
  "project-not-found",
  "ambiguous-name",
  "already-exists",
  /** The provider, model, or option asked for is not one session_models offers. */
  "invalid-model",
  /** The target session still needs attention, so the server refused to settle it. */
  "settle-blocked",
  /** The worktree to attach is missing, is the main checkout, or has another branch checked out. */
  "invalid-worktree",
  /** Spawn options that cannot be combined, such as `standalone` with `handoff`. */
  "invalid-arguments",
  /** session_release was pointed at a session the caller did not spawn. */
  "not-spawner",
  /**
   * session_wake refused a session whose queue is held after a provider
   * failure: resuming it would send the next message to the failing provider.
   */
  "queue-held",
  "dispatch-failed",
]);
export type OrchestrationToolErrorReason = typeof OrchestrationToolErrorReason.Type;

export class OrchestrationToolError extends Schema.TaggedError<OrchestrationToolError>()(
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
