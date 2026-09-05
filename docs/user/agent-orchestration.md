# Agent orchestration

An agent can start, list, wake, and settle other sessions in its own project, so one session can
coordinate a set of workers as real threads rather than hidden subagents. Each worker shows in
the sidebar, keeps its own history and checkpoints, and outlives the turn that started it.

This is off by default. Turn on **Agent orchestration** in Settings under Integrations. Like
browser access, the change applies to sessions started from then on; a running session keeps
the tools it was given.

## The tools

With the setting on, every agent session gets four tools:

- **session_spawn** starts a new session in the same project, titled with the name you give it,
  filed under a group, and kicked off with an opening message. It runs in the project directory
  on the current checkout and inherits the calling session's model and permission mode. The name
  must be unique among the project's open sessions.
- **session_list** lists the project's open sessions with their group and whether each has a
  running process behind it. Archived sessions are not included.
- **session_wake** sends a message to an existing session by name. If that session's process had
  stopped, this brings it back.
- **session_settle** settles a finished session by name, clearing it out of the inbox the same way
  the settle button does, and settling anything that session started. A session that is still
  running, waiting on an answer from you, or holding a queued turn is refused, so the orchestrator
  cannot hide work you still need to see. A session cannot settle itself, because its own turn is
  running while it asks.

Names and groups use letters, digits, dots, underscores, and hyphens only, so a ticket id such
as `T-1234` works well as a group and `T-1234-dev` as a name.

## What stays stable

A session started this way keeps its title. Automatic titling never replaces it, so the name
the orchestrator used is the name it can keep using.

For Claude Code sessions whose title is a valid session name (no spaces), the title is also the
name other Claude sessions see and can message, and it survives restarts: a session that stops
and is woken again comes back under the same name. That covers every spawned session, and any
thread you title that way yourself. A single long-lived orchestrator works well titled
`orchestrator`, driving one group per ticket.

## What to expect in the sidebar

The orchestrator holds everything it started. Its card carries a live count and a chevron:
click the chevron to show or hide the sessions below it, and the whole nest travels with the
newest session in it, so work in progress stays near the top of the list. Inside the nest the
order is the order the orchestrator started them, which reads as the pipeline it is, and it
holds still while the run proceeds. Sessions that share a group appear together under a header
showing the group name and how many of its sessions are live, oldest ticket first. Each grouped session carries a small dot, green while a process is
behind it and muted once it has stopped. Stopping a session with the stop button ends its
process; it stays in the list and can be woken by the orchestrator or by sending it a message
yourself.

Settling the orchestrator settles the sessions it started, so one click clears the whole ticket
from the inbox. A session that is still running, or that is waiting on an answer from you, is
left where it is rather than hidden.
