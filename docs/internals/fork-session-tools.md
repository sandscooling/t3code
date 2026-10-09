# Fork: session tools

The fork's agent orchestration tools, and the constraints behind them. User-facing behavior is in
[Agent orchestration](../user/agent-orchestration.md). This page is fork-owned, so upstream syncs
never touch it.

## Terms

| Term         | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| Group        | A label shared by threads that belong together, such as one ticket. Stored as `group`.      |
| Orchestrator | A thread that spawned others. Each one it spawned records it as `spawnedByThreadId`.        |
| Crew session | A thread with a `spawnedByThreadId`. Clients label it Idle between turns and keep it quiet. |

## The tools

The session tools (`session_spawn`, `session_models`, `session_projects`, `session_list`,
`session_wake`, `session_settle`, `session_rename`, `session_release`) are served on the same `t3-code` MCP endpoint
as upstream's tools, and require the `orchestration` capability, which every provider session's
credential carries. They are thin handlers over
[SessionMcpService](../../apps/server/src/mcp/toolkits/orchestration/SessionMcpService.ts), which
drives the v2 `ThreadLaunchService` and `ThreadManagementService`. A session is an ordinary
top-level thread, unlike v2's own `delegate_task` children, which are hidden subagents, and unlike
v2's thread tools, which stop at the caller's project. Spawn copies the caller's `modelSelection`
unless it is given a provider, model, or options, and checks those against `ProviderRegistry`
before launching: nothing downstream validates a selection, so a bad slug would otherwise surface
only as a provider failure on a thread that already exists.

The tools reach every project on the server, but a bare name resolves only in the caller's own
project, and anything further is addressed by threadId. Names are unique per project, settled
sessions included, since `session_wake` still reaches those by name. `session_list` hides settled
sessions (except the caller's own row, the only place a session reads its threadId), because a
settled row reads as running to an agent polling its roster. Wake is `sendToThread` in `auto`
mode, so it steers a running turn, queues behind one that cannot be steered, or starts a turn,
reopening a settled thread.

## Worktrees

Spawn launches with `skipSetupScript`, because a setup script such as a dependency install would
rewrite a directory other sessions are working in, on every spawn. T3 never creates, recreates, or
deletes the worktree a session is attached to: it only records a branch and path, after checking
the path against the worktrees git lists for that project. The guard that refuses to recreate a
missing one is `makeAttachedWorktreeGuard` in
[attachedWorktrees.ts](../../apps/server/src/git/attachedWorktrees.ts). A worktree never follows a
session into another project. If a launched thread cannot be completed (its group and spawner fail
to record), it is archived, so a half-made session does not hold the name against a retry.

## Spawner, settle cascade, and handoff

A spawned thread records its `group` and, unless spawned `standalone`, its `spawnedByThreadId`
(the caller) through `thread.metadata.update`. A standalone spawn omits the field, as a thread the
user made does, so a hub orchestrator can start a project's orchestrator without making it crew.
`session_release` lets the recorded spawner, and only it, clear the link later by setting it to
null, with no other side effect. The spawner stays ungrouped, since one orchestrator drives many
lanes.
The settle cascade is not in the tool: it is
[spawnedSessions.ts](../../apps/server/src/orchestration-v2/spawnedSessions.ts), reached from the
Orchestrator's `dispatchWithReceipt`. Every explicit `thread.settle`, from the tool, the sidebar,
or any client, settles the threads it spawned, one level deep, each as its own command under its
own lock after the parent's lock is released, and uninterruptibly. Automatic settlement
(`thread.auto-settle`) never cascades. The decider keeps sole ownership of settle eligibility; a
refusal comes back as `settle-blocked`, and a child it refuses stays open. A caller settling itself
is mid-turn, so the tool goes through `ThreadManagementService.settleThread` with `byOwnAgent`,
the same deferral `t3_thread_organize` uses: the plain `thread.settle`, cascade included, is
dispatched once that run completes. A run that ends any other way leaves it open, and so does a
message queued behind the run, which `thread.settle` refuses.

A handoff successor takes the caller's spawner, so it is the caller's sibling and settling the old
orchestrator does not take it along. Only after the successor exists does it adopt the caller's
spawned sessions; then it is pinned in the caller's slot, and the caller records
`successorThreadId`, which a client reading the caller follows. The pin and the successor link are
cosmetic and never fail a handoff. A handoff cannot be `standalone`: a successor detached that
way would vanish from its spawner's cascade unannounced, so the spawner releases it instead. The
Orchestrator refuses a `spawnedByThreadId` or
`successorThreadId` that points at the thread itself or at a missing or deleted thread.

Because a successor inherits its predecessor's spawner, a top-level orchestrator and all its
successors have none, so they are never crew sessions. The crew rules (the Idle label and silenced
completion alerts) live in [crewSession.ts](../../packages/shared/src/crewSession.ts), shared by
web, desktop, mobile, and the server's awareness feed.
