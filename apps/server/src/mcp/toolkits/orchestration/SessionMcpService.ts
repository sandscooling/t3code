/**
 * Fork-owned: the `session_*` MCP tools on Orchestrator v2. A session is an
 * ordinary top-level thread the user can watch and talk to, started with a
 * name, filed under a group, and linked to the session that spawned it unless
 * spawned standalone or released, so an orchestrator can run a crew across
 * projects. v2's own `delegate_task`
 * children are hidden subagents and its thread tools stop at the caller's
 * project; these reach any project by threadId.
 */
import {
  ALL_PROJECTS,
  CommandId,
  isProviderAvailable,
  MessageId,
  OrchestrationToolError,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type SessionListInput,
  type SessionListResult,
  type SessionModelOption,
  type SessionModelsInput,
  type SessionModelsResult,
  type SessionProjectsInput,
  type SessionProjectsResult,
  type SessionReleaseInput,
  type SessionReleaseResult,
  type SessionRenameInput,
  type SessionRenameResult,
  type SessionSettleInput,
  type SessionSettleResult,
  type SessionSpawnInput,
  type SessionSpawnResult,
  type SessionStatus,
  type SessionWakeInput,
  type SessionWakeResult,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import {
  createModelSelection,
  getProviderOptionCurrentValue,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { checkAttachedWorktree, type ListedWorktree } from "../../../git/attachedWorktrees.ts";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

type Result<A> = Effect.Effect<A, OrchestrationToolError>;

export class SessionMcpService extends Context.Service<
  SessionMcpService,
  {
    readonly spawn: (
      scope: McpInvocationScope,
      input: SessionSpawnInput,
    ) => Result<SessionSpawnResult>;
    readonly models: (
      scope: McpInvocationScope,
      input: SessionModelsInput,
    ) => Result<SessionModelsResult>;
    readonly projects: (
      scope: McpInvocationScope,
      input: SessionProjectsInput,
    ) => Result<SessionProjectsResult>;
    readonly list: (
      scope: McpInvocationScope,
      input: SessionListInput,
    ) => Result<SessionListResult>;
    readonly wake: (
      scope: McpInvocationScope,
      input: SessionWakeInput,
    ) => Result<SessionWakeResult>;
    readonly settle: (
      scope: McpInvocationScope,
      input: SessionSettleInput,
    ) => Result<SessionSettleResult>;
    readonly rename: (
      scope: McpInvocationScope,
      input: SessionRenameInput,
    ) => Result<SessionRenameResult>;
    readonly release: (
      scope: McpInvocationScope,
      input: SessionReleaseInput,
    ) => Result<SessionReleaseResult>;
  }
>()("t3/mcp/toolkits/orchestration/SessionMcpService") {}

const toolError = (reason: OrchestrationToolError["reason"], detail?: string) =>
  new OrchestrationToolError({ reason, ...(detail === undefined ? {} : { detail }) });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const requireMessage = (message: string) =>
  message.trim().length === 0
    ? toolError("invalid-name", "message must not be empty")
    : Effect.void;

/**
 * Where a session stands, for an orchestrator deciding whether to wait. A run
 * still finishing up counts as running; background work a finished turn left
 * behind (a watch, a background command) shows as monitoring, since the
 * session will speak again on its own. `held` is whether the server paused its
 * queue (after a Stop, a server restart, or a provider failure): the shell
 * presents only the newest unheld run, so without it a session with messages
 * stuck in that queue reads as ready.
 */
const sessionStatus = (thread: OrchestrationV2ThreadShell, held: boolean): SessionStatus =>
  thread.activeRunId !== null || thread.activityRunStatus != null || thread.status === "queued"
    ? "running"
    : held
      ? "held"
      : (thread.pendingBackgroundTasks ?? []).length > 0
        ? "monitoring"
        : "ready";

/** Finds a project by the projectId, name, or path session_projects reports. */
const resolveProject = (projects: ReadonlyArray<Project>, ref: string): Result<Project> =>
  Effect.gen(function* () {
    const byId = projects.find((project) => project.id === ref);
    const matches = byId
      ? [byId]
      : projects.filter((project) => project.title === ref || project.workspaceRoot === ref);
    const target = matches[0];
    if (target === undefined) {
      return yield* toolError(
        "project-not-found",
        `no project is named ${ref}; session_projects lists ${projects.map((project) => project.title).join(", ")}`,
      );
    }
    if (matches.length > 1) {
      return yield* toolError(
        "ambiguous-name",
        `${matches.length} projects are named ${ref}; pass the projectId from session_projects`,
      );
    }
    return target;
  });

/**
 * Finds the one session a tool was pointed at. A threadId reaches any
 * project, and wins outright since it is unique; it is also the only handle
 * on a session whose prose title could never pass the name pattern. A name
 * only resolves in the caller's own project, where names are unique.
 */
const resolveSession = (
  sessions: ReadonlyArray<OrchestrationV2ThreadShell>,
  caller: OrchestrationV2ThreadShell,
  ref: string,
): Result<OrchestrationV2ThreadShell> =>
  Effect.gen(function* () {
    const byId = sessions.find((thread) => thread.id === ref);
    const matches = byId
      ? [byId]
      : sessions.filter((thread) => thread.projectId === caller.projectId && thread.title === ref);
    if (matches.length === 0) {
      return yield* toolError(
        "thread-not-found",
        `no open or settled session has the threadId ${ref}, and none in your project has that name`,
      );
    }
    const target = matches[0];
    if (matches.length > 1 || target === undefined) {
      return yield* toolError(
        "ambiguous-name",
        `${matches.length} open sessions are named ${ref}; rename all but one`,
      );
    }
    return target;
  });

const describeOption = (descriptor: ProviderOptionDescriptor): SessionModelOption => {
  const fallback = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    label: descriptor.label,
    type: descriptor.type,
    ...(descriptor.type === "select"
      ? { choices: descriptor.options.map((choice) => choice.id) }
      : {}),
    ...(fallback === undefined ? {} : { default: fallback }),
  };
};

const modelOptionDescriptors = (model: ServerProvider["models"][number]) =>
  model.capabilities?.optionDescriptors ?? [];

/**
 * Turns spawn's optional provider, model, and options into the selection the
 * new thread runs on. Nothing asked for means an exact copy of the caller's.
 * Everything asked for is checked against the provider registry here, because
 * a bad slug would otherwise only fail inside the provider after the thread
 * exists, leaving the orchestrator a broken session and no reason why.
 */
const resolveSpawnModel = (
  providers: ReadonlyArray<ServerProvider>,
  inherited: ModelSelection,
  input: SessionSpawnInput,
): Result<ModelSelection> =>
  Effect.gen(function* () {
    if (
      input.instanceId === undefined &&
      input.model === undefined &&
      input.options === undefined
    ) {
      return inherited;
    }
    const instanceId = input.instanceId ?? inherited.instanceId;
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* toolError(
        "invalid-model",
        `no usable provider ${instanceId}; session_models lists ${providers.map((candidate) => candidate.instanceId).join(", ")}`,
      );
    }

    const sameProvider = provider.instanceId === inherited.instanceId;
    const requested =
      input.model ??
      (sameProvider
        ? inherited.model
        : (provider.models.find((model) => model.isDefault) ?? provider.models[0])?.slug);
    const slug =
      requested === undefined
        ? null
        : resolveSelectableModel(provider.driver, requested, provider.models);
    const model = provider.models.find((candidate) => candidate.slug === slug);
    if (model === undefined) {
      return yield* toolError(
        "invalid-model",
        `${provider.instanceId} has no model ${requested ?? "(none listed)"}; call session_models with instanceId ${provider.instanceId} for its slugs`,
      );
    }

    if (input.options === undefined) {
      // The caller's options only mean something on the caller's own model.
      const keepOptions = sameProvider && model.slug === inherited.model;
      return createModelSelection(
        provider.instanceId,
        model.slug,
        keepOptions ? inherited.options : undefined,
      );
    }
    const descriptors = modelOptionDescriptors(model);
    for (const option of input.options) {
      const descriptor = descriptors.find((candidate) => candidate.id === option.id);
      const valid =
        descriptor?.type === "select"
          ? descriptor.options.some((choice) => choice.id === option.value)
          : descriptor?.type === "boolean" && typeof option.value === "boolean";
      if (!valid) {
        return yield* toolError(
          "invalid-model",
          `${model.slug} does not accept ${option.id}=${String(option.value)}; it takes ${
            descriptors
              .map((candidate) =>
                candidate.type === "select"
                  ? `${candidate.id}=${candidate.options.map((choice) => choice.id).join("|")}`
                  : `${candidate.id}=true|false`,
              )
              .join(", ") || "no options"
          }`,
        );
      }
    }
    return createModelSelection(provider.instanceId, model.slug, input.options);
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projectService = yield* ProjectService.ProjectService;
  const registry = yield* ProviderRegistry;
  const git = yield* GitWorkflow.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;

  /**
   * Threads with a held queued run. Upstream holds a thread's queue after a
   * Stop, a server restart, or a provider failure, until a user resumes it,
   * and the thread shell never shows those runs, so the session tools read
   * them here, from the projection.
   */
  const heldQueueThreadIds = Effect.suspend(
    () => sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
      WHERE status = 'queued' AND json_extract(payload_json, '$.queueHeld') = 1
    `,
  ).pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
    Effect.mapError((error) => toolError("dispatch-failed", describe(error))),
  );
  const hasHeldQueue = (threadId: ThreadId) =>
    sql<{ readonly held: number }>`
      SELECT 1 AS held FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId} AND status = 'queued'
        AND json_extract(payload_json, '$.queueHeld') = 1
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError((error) => toolError("dispatch-failed", describe(error))),
    );

  const newCommandId = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map((uuid) => CommandId.make(`mcp:session:${uuid}`)),
  );

  const dispatch = (command: Parameters<typeof threads.dispatch>[0]) =>
    threads
      .dispatch(command)
      .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));

  /**
   * The calling session, which must hold the orchestration capability. The
   * session tools act as that thread, so an MCP client signed in from outside
   * T3 Code (no thread) is refused.
   */
  const loadCaller = Effect.fn("SessionMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* toolError("capability-unavailable", "this credential cannot control threads");
    }
    if (scope.thread === undefined) {
      return yield* toolError(
        "thread-not-found",
        "the session tools act as the calling T3 thread; this MCP client is not running inside one",
      );
    }
    const caller = yield* threads
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.mapError((error) => toolError("thread-not-found", describe(error))));
    if (caller === null || caller.deletedAt !== null) {
      return yield* toolError("thread-not-found", "the calling session has no thread");
    }
    return caller;
  });

  const liveProjects = projectService.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects.filter((project) => project.deletedAt === null)),
    Effect.mapError((error) => toolError("dispatch-failed", describe(error))),
  );

  /**
   * Who is calling and what the tools can reach: every project on this server
   * and every top-level thread in them, settled ones included. Archived and
   * deleted threads are invisible, so archiving frees a name. Subagents that
   * delegate_task made are not sessions.
   */
  const loadScope = Effect.fn("SessionMcpService.loadScope")(function* (scope: McpInvocationScope) {
    const caller = yield* loadCaller(scope);
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));
    return {
      caller,
      sessions: snapshot.threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.lineage.relationshipToParent !== "subagent",
      ),
      projects: yield* liveProjects,
    };
  });

  /** Providers a spawned session can actually start on, the same bar the model picker uses. */
  const usableProviders = registry.getProviders.pipe(
    Effect.map((providers) =>
      providers.filter(
        (provider) => provider.enabled && provider.installed && isProviderAvailable(provider),
      ),
    ),
  );

  /** Every branch git reports checked out in a worktree of the project, paging through listRefs. */
  const listProjectWorktrees = (projectRoot: string) =>
    Effect.gen(function* () {
      const worktrees: Array<ListedWorktree> = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page: VcsListRefsResult = yield* git.listRefs({
          cwd: projectRoot,
          refKind: "local",
          refresh: cursor === 0,
          cursor,
          limit: 200,
        });
        if (!page.isRepo) {
          return yield* toolError("invalid-worktree", `${projectRoot} is not a git repository`);
        }
        for (const ref of page.refs) {
          if (ref.worktreePath !== null) {
            worktrees.push({ branch: ref.name, path: ref.worktreePath });
          }
        }
        cursor = page.nextCursor;
      }
      return worktrees;
    }).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          toolError("invalid-worktree", `could not list git worktrees: ${error.message}`),
      }),
    );

  /**
   * Checks a worktree against what git lists for the project: it exists, is
   * not the main checkout, and git lists it, with `branch` checked out when
   * one is named.
   */
  const checkWorktree = (project: Project, worktreePath: string, branch: string | null) =>
    Effect.gen(function* () {
      const checked = yield* checkAttachedWorktree({
        projectRoot: project.workspaceRoot,
        path: worktreePath,
        branch,
        worktrees: yield* listProjectWorktrees(project.workspaceRoot),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (!checked.ok) {
        return yield* toolError("invalid-worktree", checked.detail);
      }
      return checked;
    });

  /**
   * Where a spawned session runs: a worktree the caller created, another
   * session's worktree, the caller's own on a handoff, or the main checkout.
   * T3 only records the branch and path; it never creates the worktree, so an
   * inherited one is checked too, in case it was removed since.
   */
  const resolveSpawnWorktree = (input: {
    readonly spawn: SessionSpawnInput;
    readonly caller: OrchestrationV2ThreadShell;
    readonly sessions: ReadonlyArray<OrchestrationV2ThreadShell>;
    readonly project: Project;
  }) =>
    Effect.gen(function* () {
      const worktree = input.spawn.worktree;
      if (worktree !== undefined && !("sameAs" in worktree)) {
        const checked = yield* checkWorktree(input.project, worktree.path, worktree.branch);
        return { branch: checked.branch, worktreePath: checked.worktreePath };
      }
      // A worktree belongs to one repository, so it never follows a session
      // into another project.
      let inherited: { readonly branch: string | null; readonly worktreePath: string | null } = {
        branch: null,
        worktreePath: null,
      };
      if (worktree !== undefined) {
        const source = yield* resolveSession(input.sessions, input.caller, worktree.sameAs);
        if (source.projectId !== input.project.id && source.worktreePath !== null) {
          return yield* toolError(
            "invalid-worktree",
            `${source.title} runs in a worktree of another project; sameAs only shares a worktree within one project`,
          );
        }
        inherited = source;
      } else if (input.spawn.handoff === true && input.caller.projectId === input.project.id) {
        inherited = input.caller;
      }
      if (inherited.worktreePath !== null) {
        yield* checkWorktree(input.project, inherited.worktreePath, null);
      }
      return { branch: inherited.branch, worktreePath: inherited.worktreePath };
    });

  /**
   * A handoff successor inherits the caller's spawner, so it is the caller's
   * sibling. A spawner deleted since would be refused by the metadata update,
   * so it is dropped instead.
   */
  const liveSpawner = (threadId: ThreadId | null | undefined) =>
    threadId == null
      ? Effect.succeed(null)
      : threads.getThreadShell(threadId).pipe(
          Effect.map((shell) => (shell !== null && shell.deletedAt === null ? shell.id : null)),
          Effect.orElseSucceed(() => null),
        );

  const spawn = Effect.fn("SessionMcpService.spawn")(function* (
    scope: McpInvocationScope,
    input: SessionSpawnInput,
  ) {
    yield* requireMessage(input.message);
    // A handoff successor takes the caller's place under the caller's
    // spawner, and detaching it silently would hide it from that spawner,
    // which can session_release it instead.
    if (input.standalone === true && input.handoff === true) {
      return yield* toolError(
        "invalid-arguments",
        "standalone and handoff cannot be combined: a handoff successor keeps your spawner; have that spawner session_release it afterwards",
      );
    }
    const { caller, sessions, projects } = yield* loadScope(scope);
    const project = yield* resolveProject(projects, input.project ?? caller.projectId);
    const clash = sessions.find(
      (thread) => thread.projectId === project.id && thread.title === input.name,
    );
    if (clash !== undefined) {
      // A settled session keeps its name, so say which kind is holding it:
      // session_list no longer shows the settled one, and "already exists"
      // about an invisible session reads as a bug.
      return yield* toolError(
        "already-exists",
        clash.settledOverride === "settled"
          ? `a settled session named ${input.name} still holds that name; session_wake reopens it, or archive it to free the name`
          : `an open session named ${input.name} already exists; use session_wake`,
      );
    }
    const modelSelection = yield* resolveSpawnModel(
      yield* usableProviders,
      caller.modelSelection,
      input,
    );
    const { branch, worktreePath } = yield* resolveSpawnWorktree({
      spawn: input,
      caller,
      sessions,
      project,
    });

    // The caller stays out of the group on purpose: one orchestrator drives
    // many lanes, and groups are the lanes, not the driver. It is the spawner
    // instead, so settling it settles what it started. A handoff makes the new
    // session the caller's sibling, since settling the old orchestrator must
    // not take its successor with it.
    const handoff = input.handoff === true;
    // A standalone session records no spawner at all, the way a thread the
    // user made has none, so nothing the caller does later reaches it.
    const spawnedByThreadId =
      input.standalone === true
        ? undefined
        : handoff
          ? yield* liveSpawner(caller.spawnedByThreadId)
          : caller.id;
    const commandId = yield* newCommandId;
    const threadId = ThreadId.make(commandId);
    // A spawn that fails once its thread exists archives that thread, so no
    // half-made session holds the name against a retry.
    const abandon = (detail: string) =>
      Effect.gen(function* () {
        const exists = yield* threads.getThreadShell(threadId).pipe(
          Effect.map((shell) => shell !== null && shell.deletedAt === null),
          Effect.orElseSucceed(() => false),
        );
        if (!exists) return yield* toolError("dispatch-failed", detail);
        const archived = yield* dispatch({
          type: "thread.archive",
          commandId: yield* newCommandId,
          threadId,
        }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return yield* toolError(
          "dispatch-failed",
          archived
            ? `${detail}; the new session ${threadId} was archived, so the name ${input.name} is free`
            : `${detail}; the new session ${threadId} could not be archived and still holds the name ${input.name}`,
        );
      });
    yield* launches
      .launch({
        commandId,
        threadId,
        projectId: project.id,
        title: input.name,
        modelSelection,
        runtimeMode: caller.runtimeMode,
        interactionMode: caller.interactionMode,
        workspaceStrategy:
          worktreePath === null
            ? { type: "root", ...(branch === null ? {} : { branch }) }
            : { type: "existing_worktree", worktreePath, ...(branch === null ? {} : { branch }) },
        initialMessage: {
          messageId: MessageId.make(commandId),
          senderThreadId: caller.id,
          text: input.message,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "mcp",
        // A setup script such as a dependency install would rewrite a
        // directory other sessions are working in, on every spawn.
        skipSetupScript: true,
      })
      .pipe(Effect.catch((error) => abandon(`${error.message} ${describe(error.cause)}`)));
    yield* dispatch({
      type: "thread.metadata.update",
      commandId: yield* newCommandId,
      threadId,
      group: input.group,
      ...(spawnedByThreadId === undefined ? {} : { spawnedByThreadId }),
    }).pipe(
      Effect.catch((error) =>
        abandon(`its group and spawner were not recorded: ${error.detail ?? error.reason}`),
      ),
    );

    // Only after the successor exists: a roster moved onto a thread that
    // never started would settle with nothing. A failure partway keeps the
    // running successor and says who moved.
    const adopted = handoff
      ? sessions.filter((thread) => thread.spawnedByThreadId === caller.id)
      : [];
    const moved: Array<string> = [];
    for (const child of adopted) {
      yield* dispatch({
        type: "thread.metadata.update",
        commandId: yield* newCommandId,
        threadId: child.id,
        spawnedByThreadId: threadId,
      }).pipe(
        Effect.mapError((error) =>
          toolError(
            "dispatch-failed",
            `handed off to ${input.name} (${threadId}), which moved ${moved.join(", ") || "no sessions"} but failed on ${child.title}: ${error.detail ?? error.reason}; the rest still name you as their spawner`,
          ),
        ),
      );
      moved.push(child.title);
    }

    if (handoff) {
      // A successor is pinned the way the user pins the one it replaces,
      // taking that one's slot when it had one. The successor link on the
      // replaced thread is what a client reading it follows. Both are
      // cosmetic, so neither fails a handoff that already ran.
      yield* dispatch({
        type: "thread.pin",
        commandId: yield* newCommandId,
        threadId,
        ...(caller.pinnedAt != null && caller.pinOrderKey != null
          ? { orderKey: caller.pinOrderKey }
          : {}),
      }).pipe(Effect.ignoreCause({ log: true }));
      yield* dispatch({
        type: "thread.metadata.update",
        commandId: yield* newCommandId,
        threadId: caller.id,
        successorThreadId: threadId,
      }).pipe(Effect.ignoreCause({ log: true }));
    }

    return {
      threadId,
      name: input.name,
      group: input.group,
      projectId: project.id,
      instanceId: modelSelection.instanceId,
      model: modelSelection.model,
      options: modelSelection.options ?? [],
      adopted: adopted.map((child) => child.title),
      branch,
      worktreePath,
    };
  });

  const models = Effect.fn("SessionMcpService.models")(function* (
    scope: McpInvocationScope,
    input: SessionModelsInput,
  ) {
    const caller = yield* loadCaller(scope);
    const providers = yield* usableProviders;
    return {
      providers: providers
        .filter(
          (provider) => input.instanceId === undefined || provider.instanceId === input.instanceId,
        )
        .map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? provider.instanceId,
          status: provider.status,
          current: provider.instanceId === caller.modelSelection.instanceId,
          models: provider.models.map((model) => ({
            slug: model.slug,
            name: model.name,
            isDefault: model.isDefault === true,
            options: modelOptionDescriptors(model).map(describeOption),
          })),
        })),
    };
  });

  const listProjects = Effect.fn("SessionMcpService.projects")(function* (
    scope: McpInvocationScope,
    input: SessionProjectsInput,
  ) {
    const caller = yield* loadCaller(scope);
    const projects = yield* liveProjects;
    const match = input.match?.toLowerCase();
    return {
      projects: projects
        .filter(
          (project) =>
            match === undefined ||
            project.title.toLowerCase().includes(match) ||
            project.workspaceRoot.toLowerCase().includes(match),
        )
        .map((project) => ({
          projectId: project.id,
          name: project.title,
          path: project.workspaceRoot,
          current: project.id === caller.projectId,
        })),
    };
  });

  const list = Effect.fn("SessionMcpService.list")(function* (
    scope: McpInvocationScope,
    input: SessionListInput,
  ) {
    const { caller, sessions, projects } = yield* loadScope(scope);
    // Own project by default: an orchestrator polling its group should not
    // pay for every other project's roster unless it asks for one.
    const projectId =
      input.project === undefined
        ? caller.projectId
        : input.project === ALL_PROJECTS
          ? null
          : (yield* resolveProject(projects, input.project)).id;
    const projectNames = new Map(projects.map((project) => [project.id, project.title]));
    const held = yield* heldQueueThreadIds;
    return {
      sessions: sessions
        .filter((thread) => projectId === null || thread.projectId === projectId)
        // A settled session is finished work; listing it beside the open ones
        // reads as "still running". The caller's own row stays regardless,
        // since it is the only place a session reads its own threadId.
        .filter((thread) => thread.id === caller.id || thread.settledOverride !== "settled")
        .filter((thread) => input.group === undefined || thread.group === input.group)
        .map((thread) => ({
          threadId: thread.id,
          name: thread.title,
          group: thread.group ?? null,
          projectId: thread.projectId,
          project: projectNames.get(thread.projectId) ?? thread.projectId,
          status: sessionStatus(thread, held.has(thread.id)),
          self: thread.id === caller.id,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        })),
    };
  });

  const wake = Effect.fn("SessionMcpService.wake")(function* (
    scope: McpInvocationScope,
    input: SessionWakeInput,
  ) {
    yield* requireMessage(input.message);
    const { caller, sessions } = yield* loadScope(scope);
    const target = yield* resolveSession(sessions, caller, input.name);
    // "auto" steers a running turn, queues behind one that cannot be steered,
    // and starts a turn otherwise. The dispatch also reopens a settled thread.
    // A steer aborts an open question or approval and the provider asks again,
    // stranding the old card (pingdotgg/t3code#15517), so that waits in the
    // queue instead. With no run in flight, "queue" starts a turn like "auto".
    // The shell is read outside the thread lock: a question raised in that
    // gap still steers.
    // A Stop, a server restart, or a provider failure holds the queue until
    // something resumes it, and a message sent past a held queue starts at
    // once, ahead of the ones waiting there. So a wake resumes it first, which
    // starts its head run when nothing else is running, and its own message
    // joins the end of that queue, even behind a running turn it could steer.
    // Only a provider failure leaves the latest executed run failed (Stop
    // interrupts it, a restart cancels it), and resuming then would hand the
    // next message to the provider that just failed, which fails it and holds
    // the queue again. That is refused instead. latestExecutedRun skips a
    // cancelled queued run that never started, which the shell's run may be.
    const held = yield* hasHeldQueue(target.id);
    if (held) {
      const { runs } = yield* threads
        .getThreadRecords(target.id, ["runs"])
        .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));
      if (latestExecutedRun(runs)?.status === "failed") {
        return yield* toolError(
          "queue-held",
          `session ${target.title} has messages held after its last turn failed in the provider; ask the user to resume the queue in the app once the provider works, or drop messages with t3_queue_cancel (t3_queue_list shows them)`,
        );
      }
      yield* dispatch({
        type: "queue.resume",
        commandId: yield* newCommandId,
        threadId: target.id,
      });
    }
    const commandId = yield* newCommandId;
    const sent = yield* threads
      .sendToThread({
        projectId: target.projectId,
        commandId,
        threadId: target.id,
        messageId: MessageId.make(commandId),
        senderThreadId: caller.id,
        text: input.message,
        attachments: [],
        mode: held || target.pendingRuntimeRequest !== null ? "queue" : "auto",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));
    // Only mode "restart" restarts a turn, so "auto" and "queue" never report it.
    const delivery = sent.delivery as Exclude<typeof sent.delivery, "restarted">;
    return { threadId: target.id, name: target.title, delivery };
  });

  const settle = Effect.fn("SessionMcpService.settle")(function* (
    scope: McpInvocationScope,
    input: SessionSettleInput,
  ) {
    const { caller, sessions } = yield* loadScope(scope);
    const target = yield* resolveSession(sessions, caller, input.name);
    // The caller is running by definition while its tool call is in flight.
    if (target.id === caller.id) {
      return yield* toolError(
        "settle-blocked",
        "a session cannot settle itself while its own turn is running; ask the user, or have the session that spawned it settle it",
      );
    }
    // The server owns settle eligibility, and an explicit settle also settles
    // the sessions the target spawned, one command each right after the
    // target's, as every other way of settling does. That finishes before
    // dispatch returns, so this only reports what it did.
    yield* threads
      .dispatch({ type: "thread.settle", commandId: yield* newCommandId, threadId: target.id })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorDispatchError" &&
          /cannot be settled/.test(String(error.cause))
            ? toolError(
                "settle-blocked",
                `session ${target.title} has a turn running or queued, or an approval pending`,
              )
            : toolError("dispatch-failed", describe(error)),
        ),
      );
    const settledWith: Array<string> = [];
    const leftOpen: Array<string> = [];
    for (const child of sessions) {
      if (child.spawnedByThreadId !== target.id || child.settledOverride === "settled") continue;
      const now = yield* threads.getThreadShell(child.id).pipe(Effect.orElseSucceed(() => null));
      (now?.settledOverride === "settled" ? settledWith : leftOpen).push(child.title);
    }
    return { threadId: target.id, name: target.title, settledWith, leftOpen };
  });

  const rename = Effect.fn("SessionMcpService.rename")(function* (
    scope: McpInvocationScope,
    input: SessionRenameInput,
  ) {
    const { caller, sessions } = yield* loadScope(scope);
    const target = yield* resolveSession(sessions, caller, input.session);
    const previousName = target.title;
    if (previousName === input.name) {
      return { threadId: target.id, name: input.name, previousName };
    }
    // Names are addresses, so a rename keeps spawn's rule: unique in the
    // project, settled sessions included, since session_wake still reaches
    // those by name.
    const clash = sessions.find(
      (thread) =>
        thread.projectId === target.projectId &&
        thread.id !== target.id &&
        thread.title === input.name,
    );
    if (clash !== undefined) {
      return yield* toolError(
        "already-exists",
        clash.settledOverride === "settled"
          ? `a settled session named ${input.name} still holds that name; rename it first, by its threadId ${clash.id}, or archive it`
          : `an open session named ${input.name} already exists`,
      );
    }
    yield* dispatch({
      type: "thread.metadata.update",
      commandId: yield* newCommandId,
      threadId: target.id,
      title: input.name,
    });
    return { threadId: target.id, name: input.name, previousName };
  });

  /**
   * The reverse of a spawn's parent link: the session keeps its group and
   * state, and only stops naming the caller as its spawner, so the caller's
   * settle and handoff no longer reach it.
   */
  const release = Effect.fn("SessionMcpService.release")(function* (
    scope: McpInvocationScope,
    input: SessionReleaseInput,
  ) {
    const { caller, sessions } = yield* loadScope(scope);
    const target = yield* resolveSession(sessions, caller, input.name);
    if (target.spawnedByThreadId !== caller.id) {
      const spawner =
        target.spawnedByThreadId == null
          ? null
          : (sessions.find((thread) => thread.id === target.spawnedByThreadId)?.title ??
            target.spawnedByThreadId);
      return yield* toolError(
        "not-spawner",
        spawner === null
          ? `session ${target.title} has no spawner, so there is nothing to release`
          : `session ${target.title} was spawned by ${spawner} (${target.spawnedByThreadId}), not you; only its spawner can release it`,
      );
    }
    yield* dispatch({
      type: "thread.metadata.update",
      commandId: yield* newCommandId,
      threadId: target.id,
      spawnedByThreadId: null,
    });
    return { threadId: target.id, name: target.title };
  });

  return SessionMcpService.of({
    spawn,
    models,
    projects: listProjects,
    list,
    wake,
    settle,
    rename,
    release,
  });
});

export const layer = Layer.effect(SessionMcpService, make);
