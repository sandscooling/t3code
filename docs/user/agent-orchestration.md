# Agent orchestration

An agent can start, list, wake, and settle other sessions in its own project, and ring you when it
needs you, so one session can
coordinate a set of workers as real threads rather than hidden subagents. Each worker shows in
the sidebar, keeps its own history and checkpoints, and outlives the turn that started it.

This is off by default. Turn on **Agent orchestration** in Settings under Integrations. Like
browser access, the change applies to sessions started from then on; a running session keeps
the tools it was given.

## The tools

With the setting on, every agent session gets six tools:

- **session_spawn** starts a new session in the same project, titled with the name you give it,
  filed under a group, and kicked off with an opening message. It runs in the project directory
  on the current checkout and inherits the calling session's permission mode. It also inherits the
  caller's provider, model, and reasoning effort unless the agent names others, so an orchestrator
  can run one prompt on several models side by side, or hand a review to Codex from a Claude
  session. The name must be unique among the project's open sessions.
- **session_models** lists the providers and models a spawned session can use, with each model's
  options such as reasoning effort. Only providers that are enabled and installed appear.
- **session_list** lists the project's open sessions with their group and whether each has a
  running process behind it. Settled and archived sessions are not included, so a group's list
  empties as its sessions finish and the agent driving them sees only what is still in flight.
- **session_wake** sends a message to an existing session by name. If that session's process had
  stopped, this brings it back.
- **session_notify** rings you: a sound, a toast, and a desktop notification on every client
  attached to this server. It is for when an agent needs an answer and you may be away from the
  screen. The tool reports how many clients heard it, so an agent told nobody was connected can
  say so instead of waiting. Sub-agents can report to one orchestrator and let that orchestrator
  do the ringing, which is the difference between this and a hook: a hook fires for every agent.
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

## Being rung

**Agent attention alerts** in Settings under Integrations controls this, next to Agent
orchestration. Turn it off and pings are dropped server side, so an agent cannot ring a
device you silenced from another one.

**Ping sound** picks the sound a ping plays when the agent does not name one: Chime, Ping,
Alert, Knock, or your own file. Choosing one plays it, and the Play button repeats it. An agent
can override the choice per call, so an orchestrator can keep Knock for routine questions and
Alert for the one that blocks a release.

Pick **Your own file** to use a sound you already have. Browse opens a file dialog on the
machine running the server, starting in the Windows Media folder where the system sounds live.
Anything Chromium can play works: wav, mp3, ogg, opus, m4a, aac, flac, weba. The file stays
where it is and is read from the server host, so every client rings with the same sound,
including a phone that has never seen the file. If the file is moved or renamed later, the row
says so and pings fall back to Chime rather than going silent.

A ping older than two minutes never rings. Clients re-attach their subscription when a
connection drops, and a sound for a question you answered an hour ago teaches you to ignore
the sound.

Browsers only allow sound after you have interacted with the page, so a tab you have never
clicked in may show the toast without the tone. The desktop notification does not depend on
that, and the Play button in Settings is enough to unblock the tone for the rest of the session.
