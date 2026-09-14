# Agent orchestration

An agent can start, list, wake, and settle other sessions in any project on its server, so one
session can
coordinate a set of workers as real threads rather than hidden subagents. Each worker shows in
the sidebar, keeps its own history and checkpoints, and outlives the turn that started it.

This is off by default. Turn on **Agent orchestration** in Settings under Integrations. Like
browser access, the change applies to sessions started from then on; a running session keeps
the tools it was given.

## The tools

With the setting on, every agent session gets six tools:

- **session_spawn** starts a new session, titled with the name you give it, filed under a group,
  and kicked off with an opening message. It starts in the caller's project unless the agent names
  another, so one long-lived orchestrator can run work in all of your projects. It runs in that
  project's directory on its current checkout and inherits the calling session's permission mode. It also inherits the
  caller's provider, model, and reasoning effort unless the agent names others, so an orchestrator
  can run one prompt on several models side by side, or hand a review to Codex from a Claude
  session. The name must be unique among that project's open sessions. With the handoff option,
  the new session replaces the caller instead; see below.
- **session_models** lists the providers and models a spawned session can use, with each model's
  options such as reasoning effort. Only providers that are enabled and installed appear.
- **session_projects** lists the projects on this server that the other tools can reach.
- **session_list** lists open sessions with their project, their group, and whether each has a
  running process behind it: the caller's own project by default, or another project, or all of
  them. Settled and archived sessions are not included, so a group's list empties as its sessions
  finish and the agent driving them sees only what is still in flight.
- **session_wake** sends a message to an existing session. If that session's process had stopped,
  this brings it back.
- **session_settle** settles a finished session, clearing it out of the inbox the same way the
  settle button does, and settling anything that session started, in any project. A session that is still
  running, waiting on an answer from you, or holding a queued turn is refused, so the orchestrator
  cannot hide work you still need to see. A session cannot settle itself, because its own turn is
  running while it asks.

Names and groups use letters, digits, dots, underscores, and hyphens only, so a ticket id such
as `T-1234` works well as a group and `T-1234-dev` as a name.

A name reaches sessions in the agent's own project only, since two projects can each have a
session with the same name. Sessions in other projects are reached by the id `session_list`
reports, and a session learns its own id the same way, which is how a worker in one project
reports back to an orchestrator in another. A spawned session shows in the sidebar under the
project it runs in.

## What stays stable

A session started this way keeps its title. Automatic titling never replaces it, so the name
the orchestrator used is the name it can keep using.

For Claude Code sessions whose title is a valid session name (no spaces), the title is also the
name other Claude sessions see and can message, and it survives restarts: a session that stops
and is woken again comes back under the same name. That covers every spawned session, and any
thread you title that way yourself. A single long-lived orchestrator works well titled
`orchestrator`, driving one group per ticket.

## Settling what a session started

Each spawned session remembers the session that started it. Settling the orchestrator settles
the sessions it started, so one click clears the whole ticket from the inbox. A session that is
still running, or that is waiting on an answer from you, is left where it is rather than hidden.

Stopping a session with the stop button ends its process; it stays in the list and can be woken
by the orchestrator or by sending it a message yourself.

## Handing off a long-running orchestrator

An orchestrator's history keeps growing. Instead of compacting it, ask it to hand off to a
successor: a fresh session that carries on the same work, while the old one is settled and stops
adding to the database.

### What the handoff option does

Calling **session_spawn** with `handoff: true` does two things in one call:

- **The successor becomes the caller's sibling, not its child.** It takes the caller's own parent,
  or no parent when the caller was started by hand. Settling the old orchestrator therefore never
  settles its successor.
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
2. **Pick a successor name.** It must differ from every open or settled session in the project,
   including the old orchestrator's own name, which stays taken until that thread is archived.
   `orchestrator-2` is a good pattern.
3. **Write the opening message.** It is the successor's only context, so include:
   - the goal and the current plan, and the decisions already made
   - the roster from step 1, with what each session is doing and what it is waiting for
   - anything in flight: messages sent but not answered, reviews pending, commits not yet made
   - the old orchestrator's name and threadId
   - the successor's first actions, in order: steps 1 to 3 of the next list
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
3. **Settle the old orchestrator** with **session_settle**, by name or threadId. If it is refused
   as still running, its turn has not ended yet; wait and try again. Its moved sessions stay open.

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
