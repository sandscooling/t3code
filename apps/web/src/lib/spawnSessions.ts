import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useRef } from "react";

import {
  NEW_THREAD_PROJECTS_GROUP,
  parseSessionSpawnQuery,
} from "../components/sessionFleet.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { primaryServerSettingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { vcsEnvironment } from "../state/vcs";
import type { Project } from "../types";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { readT3ProjectFile } from "./t3ProjectFileDefaults";
import { newMessageId, newThreadId } from "./utils";

/**
 * Opening message for a spawned standby session. The agent instruction file
 * gives this phrase its meaning (hold at standby, await instructions), so the
 * session boots without inventing work for itself. Changing the wording here
 * without changing that instruction leaves the fleet guessing.
 */
export function sessionStandbyMessage(index: number): string {
  return `Session ${index}`;
}

interface StartTurnResult {
  readonly _tag: string;
}

export interface SpawnSessionsInput {
  readonly count: number;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly modelSelection: ModelSelection;
  readonly envMode: ThreadEnvMode;
  /** Base branch for worktree mode. Ignored when the env mode is local. */
  readonly baseBranch: string | null;
  readonly startFromOrigin: boolean;
  readonly startTurn: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: StartThreadTurnInput;
  }) => Promise<StartTurnResult>;
}

export interface SpawnSessionsResult {
  readonly started: number;
  readonly failed: number;
}

/**
 * Starts `count` sessions in one project, each already running so it registers
 * as a peer an orchestrator can address. A draft thread never spawns a provider
 * process, so the opening turn is what makes the session real. That is why this
 * uses `bootstrap.createThread` rather than a create-then-send pair.
 *
 * Sequential on purpose: in worktree mode every session cuts a checkout from
 * the same repository, and git does not appreciate that happening N ways at
 * once.
 */
export async function spawnSessions(input: SpawnSessionsInput): Promise<SpawnSessionsResult> {
  const useWorktree = input.envMode === "worktree" && input.baseBranch !== null;
  let started = 0;
  let failed = 0;

  for (let index = 1; index <= input.count; index += 1) {
    const title = `Session ${index}`;
    const createdAt = new Date().toISOString();
    const result = await input.startTurn({
      environmentId: input.environmentId,
      input: {
        threadId: newThreadId(),
        message: {
          messageId: newMessageId(),
          role: "user",
          text: sessionStandbyMessage(index),
          attachments: [],
        },
        modelSelection: input.modelSelection,
        // No titleSeed: a seed equal to the title makes the title eligible for
        // automatic replacement, and a spawned session must keep its name.
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        bootstrap: {
          createThread: {
            projectId: input.projectId,
            title,
            modelSelection: input.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: useWorktree ? input.baseBranch : null,
            worktreePath: null,
            createdAt,
          },
          ...(useWorktree && input.baseBranch
            ? {
                // The server names the worktree branch, and fails the launch
                // rather than falling back to the project checkout.
                prepareWorktree: {
                  projectCwd: input.projectCwd,
                  baseBranch: input.baseBranch,
                  requireWorktree: true,
                  ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
                },
                runSetupScript: true,
              }
            : {}),
        },
        createdAt,
      },
    });

    if (result._tag === "Failure") {
      failed += 1;
    } else {
      started += 1;
    }
  }

  return { started, failed };
}

/**
 * The command palette's "New thread in..." session fleet. The query there can
 * carry a trailing count ("fleet 5"); this splits it off so the palette filters
 * by the project name alone, and `runProject` starts the fleet when a count was
 * typed. `runProject` returns false when there is no count, so the caller goes
 * on to start a single thread as usual.
 */
export function useSessionFleet(input: {
  readonly groups: ReadonlyArray<{ readonly value: string }> | undefined;
  readonly query: string;
  readonly deferredQuery: string;
  readonly fallbackModelSelection: ModelSelection | null;
}) {
  const { fallbackModelSelection } = input;
  const acceptsSessionCount =
    input.groups?.some((group) => group.value === NEW_THREAD_PROJECTS_GROUP) === true;
  const count = acceptsSessionCount ? parseSessionSpawnQuery(input.query).count : null;
  // The count is split off before filtering, since otherwise the digits join
  // the project filter and the list goes empty with nothing to select.
  const filterQuery = acceptsSessionCount
    ? parseSessionSpawnQuery(input.deferredQuery).filterText
    : input.deferredQuery;
  // Read at execution time, so the project item closures do not go stale as
  // the count is typed.
  const countRef = useRef<number | null>(null);
  countRef.current = count;

  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const loadProjectBranches = useAtomQueryRunner(vcsEnvironment.listRefs, {
    reportFailure: false,
  });
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);

  /**
   * Starts a fleet of standby sessions in one project, each one already running
   * so it registers as a peer that an orchestrator session can address. Env mode
   * follows the project's own default, so a fleet lands wherever a single new
   * thread in that project would have.
   */
  const startSessionFleet = useCallback(
    async (project: Project, fleetCount: number): Promise<void> => {
      const modelSelection = project.defaultModelSelection ?? fallbackModelSelection;
      if (modelSelection === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "No model to start with",
            description: `Set a default model for ${project.title}, then spawn sessions.`,
          }),
        );
        return;
      }

      // The shared resolver owns the priority order, and the t3.json read is
      // skipped when a higher-priority source already decides.
      const projectSettings = resolveProjectSettings(primaryServerSettings, project.id, project);
      const projectFile =
        projectSettings.settings.defaultThreadEnvMode === null
          ? await readT3ProjectFile(project.environmentId, project.workspaceRoot)
          : null;
      const envMode = resolveProjectSettings(
        primaryServerSettings,
        project.id,
        project,
        projectFile,
      ).settings.defaultThreadEnvMode;

      // Worktree mode needs a base branch to cut from. The project's checked-out
      // branch is the same starting point the composer offers by default.
      let baseBranch: string | null = null;
      if (envMode === "worktree") {
        const refsResult = await loadProjectBranches({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot, refKind: "local" },
        });
        if (refsResult._tag === "Success") {
          const refs = refsResult.value.refs;
          baseBranch =
            refs.find((ref) => ref.current)?.name ??
            refs.find((ref) => ref.isDefault)?.name ??
            null;
        }
        if (baseBranch === null) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "No base branch",
              description: `${project.title} starts threads in a worktree, but its current branch could not be read.`,
            }),
          );
          return;
        }
      }

      const result = await spawnSessions({
        count: fleetCount,
        environmentId: project.environmentId,
        projectId: project.id,
        projectCwd: project.workspaceRoot,
        modelSelection,
        envMode,
        baseBranch,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode,
          newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
        }),
        startTurn: startThreadTurn,
      });

      toastManager.add(
        stackedThreadToast({
          type: result.failed > 0 ? "error" : "success",
          title:
            result.failed > 0
              ? `Started ${result.started} of ${fleetCount} sessions`
              : `Started ${result.started} ${result.started === 1 ? "session" : "sessions"}`,
          description: project.title,
        }),
      );
    },
    [fallbackModelSelection, loadProjectBranches, primaryServerSettings, startThreadTurn],
  );

  const runProject = useCallback(
    async (project: Project): Promise<boolean> => {
      const fleetCount = countRef.current;
      if (fleetCount === null) {
        return false;
      }
      await startSessionFleet(project, fleetCount);
      return true;
    },
    [startSessionFleet],
  );

  return { acceptsSessionCount, count, filterQuery, runProject };
}
