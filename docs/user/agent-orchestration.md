# Agent orchestration

An agent can start, list, wake, and settle other sessions in any project on its server, so one
session can coordinate a set of workers as real threads rather than hidden subagents. Each worker
shows in the sidebar, keeps its own history and checkpoints, and outlives the turn that started
it.

There is nothing to turn on: every agent session has these tools.

## The tools

Every agent session gets eight tools:

- **session_spawn** starts a new session, titled with the name you give it, filed under a group,
  and kicked off with an opening message. It starts in the caller's project unless the agent names
  another, so one long-lived orchestrator can run work in all of your projects. It runs on that
  project's main checkout, or in an existing git worktree (see
  [Running sessions in worktrees](#running-sessions-in-worktrees)), and inherits the calling
  session's permission mode. It also inherits the caller's provider, model, and reasoning effort unless the agent names others, so an orchestrator
  can run one prompt on several models side by side, or hand a review to Codex from a Claude
  session. No other open or settled session in that project may hold the name. With the handoff
  option, the new session replaces the caller instead; see below. With the `standalone` option,
  the new session is not part of the caller's crew: settling or handing off the caller never
  touches it. Use it when one orchestrator sets up a new project and starts that project's own
  orchestrator.
- **session_models** lists the providers and models a spawned session can use, with each model's
  options such as reasoning effort. Only providers that are enabled and installed appear.
- **session_projects** lists the projects on this server that the other tools can reach.
- **session_list** lists open sessions with their project, their group, the branch and worktree
  they run in, and a status: `running` while a turn is in flight, `monitoring` when the last turn
  ended but left a watch or background command going, and `ready` otherwise. It lists the caller's
  own project by default, or another project, or all of them. Settled and archived sessions are
  not included, so a group's list empties as its sessions finish and the agent driving them sees
  only what is still in flight.
- **session_wake** sends a message to an existing session. A session mid-turn takes it as a steer,
  or queues it when its turn cannot be steered; any other session, settled ones included, starts a
  new turn with it. The message shows in that session as sent by another agent, with a link back
  to the sender.
- **session_settle** settles a finished session, clearing it out of the inbox the same way the
  settle button does, and settling anything that session started, in any project. A session that
  is still running, waiting on an answer from you, or holding a queued turn is refused, so the
  orchestrator cannot hide work you still need to see. A session can settle itself, which takes
  effect once its current turn finishes; if that turn fails or is stopped, or a message is waiting
  for it, it stays open.
- **session_rename** renames a session, including the caller itself. The new name follows the same
  rules as a spawned session's name, and no other open or settled session in that project may
  hold it. To reuse a settled session's name, rename that session first.
- **session_release** detaches a session the caller started, as if it had been spawned
  `standalone`. Nothing else about it changes. Only the session that started it can release it.

Names and groups use letters, digits, dots, underscores, and hyphens only, so a ticket id such
as `T-1234` works well as a group and `T-1234-dev` as a name.

A name reaches sessions in the agent's own project only, since two projects can each have a
session with the same name. Sessions in other projects are reached by the id `session_list`
reports, and a session learns its own id the same way, which is how a worker in one project
reports back to an orchestrator in another. A spawned session shows in the sidebar under the
project it runs in.

## Running sessions in worktrees

Parallel workers editing one checkout step on each other. To give a line of work its own copy of
the code, create a git worktree for it yourself (for example with `git worktree add`), then
attach sessions to it through the `worktree` option of **session_spawn**:

- **The first session of a lane** passes `worktree: { path, branch }`: the worktree's absolute
  path and the branch checked out there. The spawn is refused unless git lists that path as a
  worktree of the project, it is not the project's own checkout, and it has that branch checked
  out.
- **Every other session in the lane** passes `worktree: { sameAs }` with the name or threadId of a
  session already there. A session on the main checkout passes that on too.
- **A handoff successor** stays in the caller's worktree without asking.

Everything the session does, from its turns to its terminal and diffs, happens in that worktree.
The result of **session_spawn** and each row of **session_list** report the `branch` and
`worktreePath` a session runs in; both are null on the main checkout.

T3 Code never creates, recreates, or deletes a worktree you attach this way. If the folder
disappears, the session's next turn fails with a message saying so, instead of T3 Code rebuilding
it. Deleting such a thread with "delete the worktree too" leaves the folder in place. Remove the
worktree yourself with `git worktree remove` when the lane is done.

## In the sidebar

Each spawned session is an ordinary thread with its own row, under the project it runs in. To
keep a project's sessions together, turn on **Group threads by project** in Settings,
Appearance; the project's orchestrator then leads its group.

A spawned session that has finished a turn shows **Idle** instead of Done, on desktop, web, and
mobile, because it is waiting for its orchestrator rather than for you. Its finished turns make no
sound, popup, or phone notification. A failure, a question, or an approval request from it still
alerts you. The orchestrator itself, and threads you started, behave as usual.

## What stays stable

A session started this way keeps its title. Automatic titling never replaces it, so the name
the orchestrator used is the name it can keep using until someone renames it. A thread id never
changes, so it is the address to hand out when a name might. A single long-lived orchestrator
works well titled `orchestrator`, driving one group per ticket.

## Settling what a session started

Each spawned session remembers the session that started it, unless it was spawned `standalone`
or later released. Settling the orchestrator settles
the sessions it started, whether you settle it from the sidebar, with the settle button, or an
agent uses **session_settle**, so one click clears the whole ticket from the inbox. A session
that is still running, or that is waiting on an answer from you, is left where it is rather than
hidden. A thread settled automatically by your settle rules leaves its sessions open.

Stopping a session's turn with the stop button leaves it in the list, and it can be woken by the
orchestrator or by sending it a message yourself.

## Handing off a long-running orchestrator

An orchestrator's history keeps growing. Instead of compacting it, ask it to hand off to a
successor: a fresh session that carries on the same work, while the old one is settled and stops
adding to the database.

### What the handoff option does

Calling **session_spawn** with `handoff: true` does two things in one call:

- **The successor becomes the caller's sibling, not its child.** It takes the caller's own parent,
  or no parent when the caller was started by hand. Settling the old orchestrator therefore never
  settles its successor. It also runs in the caller's worktree, unless the call passes `worktree`.
- **Every session the caller started moves to the successor.** This is called adopting. Settled
  sessions move too, so waking one later still ties it to the successor. The sessions move only
  after the successor's first turn has started; if it fails to start, nothing moves.

The result lists the names of the moved sessions in `adopted`. Without `handoff`, `adopted` is
always empty.

Only the caller's direct children move. A session that one of those workers started stays under
that worker, which is correct: it settles with the worker, and the worker now belongs to the
successor.

There is no separate way to adopt sessions. They move only inside the handoff call.

### Steps for the old orchestrator

1. **Collect the state.** Call **session_list** for every project the work touches (or `*`), and
   note each open session's name, threadId, project, group, and status, plus which of them are
   waiting on you or on each other.
2. **Pick a temporary successor name.** It must differ from every open or settled session in the
   project, including the old orchestrator's own name, which is still taken during the handoff.
   `orchestrator-2` is a good pattern. The successor takes the old name back at the end.
3. **Write the opening message.** It is the successor's only context, so include:
   - the goal and the current plan, and the decisions already made
   - the roster from step 1, with what each session is doing and what it is waiting for
   - anything in flight: messages sent but not answered, reviews pending, commits not yet made
   - the old orchestrator's name and threadId
   - the successor's first actions, in order: steps 1 to 4 of the next list
4. **Call session_spawn** with the successor name, a group, the message, and `handoff: true`.
5. **Check the result before anything else.** If the old orchestrator had spawned sessions, their
   names must appear in `adopted`. If `adopted` is empty, the handoff did not happen and the
   successor is a child of the old orchestrator. Tell the user, and do not ask anyone to settle
   the old orchestrator: that would settle the successor with it.
6. **End the turn.** Do not start new work, because the successor now owns it.

### Steps for the successor

1. **Learn your own address.** Call **session_list**; the row marked `self` holds your threadId.
2. **Give every adopted session the new address.** Workers were told to report to the old
   orchestrator's name or threadId, and those still point at the old thread. Call **session_wake**
   on each adopted session with a short message naming you as the new orchestrator and your
   threadId. Skip settled ones unless you need them again.
3. **Settle the old orchestrator** with **session_settle**, by threadId. If it is refused as still
   running, its turn has not ended yet; wait and try again. Its moved sessions stay open.
4. **Take the old name.** Only after the settle succeeds:
   - rename the old orchestrator with **session_rename**, by its threadId, to a retired name such
     as `Orchestrator-2026-09-13`
   - rename yourself to the old name, for example from `orchestrator-2` to `Orchestrator`

   The name works for **session_wake** at once. Step 2 still hands out your threadId, since a
   threadId never changes and reaches you from any project.

### If something goes wrong

- **`adopted` came back empty:** leave the old orchestrator open. Its sessions still settle with
  it, so settle it only once they are finished. Start the next successor from a session that can
  see the handoff option.
- **The handoff option is missing from session_spawn:** the calling session loaded the tools
  before T3 Code was updated. A Claude session keeps the tool descriptions it first loaded, even
  after a restart or another tool search, so only a new session sees the option. Ask the user to
  start the successor by hand, and follow the "adopted came back empty" rule for the old
  orchestrator.
- **You are settling the old orchestrator yourself, as the user:** check first that the handoff
  reported the sessions you care about in `adopted`. The sidebar does not show which session
  started which, so that result is the only confirmation. Any session that did not move settles
  with the old orchestrator.
