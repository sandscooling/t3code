import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

import { newMessageId, newThreadId, randomHex } from "./utils";

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
                prepareWorktree: {
                  projectCwd: input.projectCwd,
                  baseBranch: input.baseBranch,
                  branch: buildTemporaryWorktreeBranchName(randomHex),
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
