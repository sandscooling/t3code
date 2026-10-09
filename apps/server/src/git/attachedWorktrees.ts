/**
 * Fork-owned: worktrees an outside orchestrator created and attached sessions
 * to. T3 records their branch and path but never creates, recreates, or
 * deletes them. Its own worktrees live under `ServerConfig.worktreesDir`, so
 * that directory is the line between the two.
 */
// @effect-diagnostics nodeBuiltinImport:off - native realpath; see realPathOfNearestAncestor.
import * as NodeFSP from "node:fs/promises";

import {
  GitCommandError,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

/** A turn start on an attached worktree whose directory is gone. */
export class AttachedWorktreeMissingError extends Schema.TaggedError<AttachedWorktreeMissingError>()(
  "AttachedWorktreeMissingError",
  { worktreePath: Schema.String },
) {
  override get message(): string {
    return `Attached worktree ${this.worktreePath} no longer exists. T3 does not recreate worktrees it did not create.`;
  }
}

export const isAttachedWorktreeMissingError = Schema.is(AttachedWorktreeMissingError);

/**
 * The real path of `resolved`, or for a missing path the real path of its
 * nearest existing ancestor with the missing tail re-appended, so a gone
 * worktree under a junction still lands where its root does. Native realpath,
 * because Effect's FileSystem.realPath is Node's JS one, which leaves Windows
 * 8.3 short names (C:\Users\KEVINL~1) unexpanded.
 */
const realPathOfNearestAncestor = Effect.fnUntraced(function* (resolved: string) {
  const path = yield* Path.Path;
  const missing: Array<string> = [];
  let current = resolved;
  for (;;) {
    const real = yield* Effect.tryPromise(() => NodeFSP.realpath(current)).pipe(Effect.option);
    if (Option.isSome(real)) return path.join(real.value, ...missing.toReversed());
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missing.push(path.basename(current));
    current = parent;
  }
});

/**
 * Canonical form for comparing paths: the real path (see above), normalized,
 * without a trailing separator, and lowercased on Windows where paths are
 * case-insensitive.
 */
export const comparablePath = Effect.fnUntraced(function* (target: string) {
  const path = yield* Path.Path;
  const real = yield* realPathOfNearestAncestor(path.resolve(target));
  const trimmed = path.normalize(real).replace(/[\\/]+$/, "");
  const key =
    trimmed.length === 0 || /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}${path.sep}` : trimmed;
  return (yield* HostProcessPlatform) === "win32" ? key.toLowerCase() : key;
});

/** True when `target` sits strictly inside `root`; false when outside or equal. */
export const isInsideDirectory = Effect.fnUntraced(function* (root: string, target: string) {
  const path = yield* Path.Path;
  const relative = path.relative(yield* comparablePath(root), yield* comparablePath(target));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
});

/** True for a worktree T3 created itself; false for an attached one. */
export const isInsideT3WorktreesDir = Effect.fnUntraced(function* (target: string) {
  const config = yield* ServerConfig;
  return yield* isInsideDirectory(config.worktreesDir, target);
});

/** What ProviderTurnStartService's layer needs for the guard below. */
export type AttachedWorktreeGuardServices = ServerConfig | Path.Path;

/**
 * Builds ProviderTurnStartService's guard for a missing worktree: one outside
 * T3's own worktrees dir was attached, not created, so T3 never recreates it.
 * The guard settles the run as failed ("Attached worktree missing") through the
 * service's `settleRunBeforeStart` and returns true, and the caller returns
 * before its recreate. A missing worktree T3 created returns false.
 */
export const makeAttachedWorktreeGuard = Effect.gen(function* () {
  const context = yield* Effect.context<AttachedWorktreeGuardServices>();
  return <E>(input: {
    readonly worktreePath: string;
    readonly run: Pick<OrchestrationV2Run, "providerInstanceId">;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly settleRunBeforeStart: (settle: {
      readonly signal: string;
      readonly status: "failed";
      readonly now: DateTime.Utc;
      readonly startedAt: DateTime.Utc;
      readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
      readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
      readonly item: Pick<
        Extract<OrchestrationV2TurnItem, { type: "error" }>,
        "type" | "title" | "failure"
      >;
      readonly providerThreadUpdate: OrchestrationV2ProviderThread;
    }) => Effect.Effect<unknown, E>;
  }) =>
    Effect.gen(function* () {
      const { worktreePath, providerThread } = input;
      if (yield* isInsideT3WorktreesDir(worktreePath).pipe(Effect.provideContext(context))) {
        return false;
      }
      const now = yield* DateTime.now;
      yield* input.settleRunBeforeStart({
        signal: "attached-worktree-missing",
        status: "failed",
        now,
        startedAt: now,
        providerInstanceId: input.run.providerInstanceId,
        itemProviderThreadId: providerThread.id,
        item: {
          type: "error",
          title: "Attached worktree missing",
          failure: makeProviderFailure({
            class: "validation_error",
            message: new AttachedWorktreeMissingError({ worktreePath }).message,
          }),
        },
        providerThreadUpdate: {
          ...providerThread,
          status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
          updatedAt: now,
        },
      });
      return true;
    });
});

/**
 * Guards the `vcs.removeWorktree` RPC, which runs `git worktree remove --force`:
 * a worktree outside T3's own dir was attached, not created, so it stays.
 */
export const refuseAttachedWorktreeRemoval = Effect.fnUntraced(function* (
  input: VcsRemoveWorktreeInput,
) {
  if (yield* isInsideT3WorktreesDir(input.path)) return;
  return yield* new GitCommandError({
    operation: "GitWorkflowService.removeWorktree",
    command: "git worktree remove",
    cwd: input.cwd,
    detail: `T3 only deletes worktrees it created; ${input.path} was left in place.`,
  });
});

export interface ListedWorktree {
  readonly branch: string;
  readonly path: string;
}

export type AttachedWorktreeCheck =
  | { readonly ok: true; readonly branch: string; readonly worktreePath: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Checks a caller-supplied worktree against what git lists for the project:
 * an existing directory, not the project's own checkout, listed by
 * `git worktree list`, with the named branch checked out (any branch when
 * `branch` is null). On success the path is the one git reports, so later
 * comparisons stay stable.
 */
export const checkAttachedWorktree = Effect.fnUntraced(function* (input: {
  readonly projectRoot: string;
  readonly path: string;
  readonly branch: string | null;
  readonly worktrees: ReadonlyArray<ListedWorktree>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (detail: string): AttachedWorktreeCheck => ({ ok: false, detail });
  if (!path.isAbsolute(input.path)) {
    return fail(`${input.path} is not an absolute path`);
  }
  const info = yield* fs.stat(input.path).pipe(Effect.option);
  if (info._tag === "None") {
    return fail(`${input.path} does not exist`);
  }
  if (info.value.type !== "Directory") {
    return fail(`${input.path} is not a directory`);
  }
  const requested = yield* comparablePath(input.path);
  if (requested === (yield* comparablePath(input.projectRoot))) {
    return fail(
      `${input.path} is the project's own checkout; omit worktree to run there, or pass a worktree you created`,
    );
  }
  for (const worktree of input.worktrees) {
    if ((yield* comparablePath(worktree.path)) !== requested) continue;
    if (input.branch !== null && worktree.branch !== input.branch) {
      return fail(`${input.path} has ${worktree.branch} checked out, not ${input.branch}`);
    }
    return { ok: true, branch: worktree.branch, worktreePath: worktree.path } as const;
  }
  return fail(
    `git worktree list for ${input.projectRoot} does not list ${input.path} with a branch checked out; create it with git worktree add first`,
  );
});
