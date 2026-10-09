# T3 Code, S&S Cooling Fork

My working fork of [T3 Code](https://github.com/pingdotgg/t3code). It is my daily driver, not a release channel. For the real project, read [the upstream README](./README.upstream.md) or go to [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

> **_NOTE_**
> Nothing here is an official build. Upstream ships at [t3.codes](https://t3.codes) and on [GitHub Releases](https://github.com/pingdotgg/t3code/releases).

The branch is `kevlingo/features`, kept current by merging upstream `main`. When upstream ships something that does the same job as a fork feature, upstream wins and the fork feature is removed.

## What the fork adds

### Agent orchestration

Always available to every agent session, with no setting to turn on:

- MCP tools that let one session drive others: `session_spawn`, `session_list`, `session_wake`, `session_settle`, `session_rename`, `session_release`, `session_models`, `session_projects`. A `session_spawn` with `standalone` starts a session with no spawner (such as a new project's orchestrator), so settling or handing off the caller never reaches it, and `session_release` detaches a session the caller already spawned in the same way. `session_list` reports each session as `running`, `held` (messages wait in a queue the server paused after a Stop, a server restart, or a provider failure), `monitoring` (its turn ended but a watch or background command is still going), or `ready`. A `session_wake` to a session with a question or approval open waits in its queue instead of interrupting it, and one to a held session resumes the queue and joins its end, so earlier messages still run first. After a provider failure the wake is refused instead, so a retry cannot spend each held message on the failing provider. Only an agent running inside a T3 thread can call these tools, and the ones that change something need that thread's turn to be live; an outside agent signed in to the MCP server is refused.
- `session_spawn` can pick the provider, model and reasoning effort, and can start work in any project on the server.
- A spawned session that finishes a turn shows "Idle" in the sidebar and on mobile instead of "Done", until it is settled, and its finished turns make no sound, popup or phone notification (failures, questions and approvals still alert). A spawned session titled exactly "Orchestrator" is the exception: it reads Done and unread and alerts like any other thread. In the desktop and web sidebar, a "Waiting" thread shows how long its background work has been running, with an icon for what it waits on (a bot for an agent, a terminal for a command, a pull request icon for a watched pull request).
- Spawned sessions record the thread that spawned them. Settling an orchestrator settles what it spawned. A session can `session_settle` itself; it settles when its current turn completes.
- `session_spawn` with `handoff` replaces a long-running orchestrator: the successor becomes its sibling and takes over every session it spawned, so the old one can be settled. The successor is pinned automatically, in the old one's pinned slot if it had one. A client reading the old orchestrator when it hands off follows to the successor.
- `session_spawn` can attach a session to an existing git worktree you created, by path and branch or by naming a session already in it; a handoff successor stays in its predecessor's worktree. T3 never creates, recreates, or deletes these attached worktrees.
- The command palette's "New thread in..." takes a count, so `fleet 5` starts five sessions at once.
- Each project can mark its orchestrator's sidebar card with a colored bar down its left edge. Right-click the orchestrator, or the project header when threads are grouped by project, and pick "Orchestrator color". A thread counts as the orchestrator only when it is named exactly `Orchestrator`, so a session spawned by a chained crew member never takes the color, and a handoff successor takes it once it renames itself. The choice is saved on this device only.

### Chat and composer

- Images an agent generates or views (a Codex generated image, a Read of a png) get their own work log row, show without expanding it, and stay out of the "+N tool calls" fold. From closed upstream PR [#5114](https://github.com/pingdotgg/t3code/pull/5114).
- An answered question stays out of the "+N tool calls" fold, so the tool calls after it cannot hide it.
- The latest finished turn shows its work expanded under its "Worked for" row; older turns fold. Click the row to collapse it.
- A plan usage pill in the composer, showing how much of the current plan window is used.
- The background work banner shows how long the newest command or watch has been running.
- An agent's HTML page shows as a card in the chat and opens in the right panel; a new page opens there by itself while you watch the thread. During a question round, a page titled with the question's header (like "Q2 ...") opens as that question comes up; such pages never open by themselves when published, so a round's pages load in the background. On a narrow window it stays inline.

### Threads and sidebar

- A setting to group the sidebar by project (Settings, Appearance, "Group threads by project"). Each project folds and shows how many of its threads are working or monitoring, and a project's orchestrator leads its group as the first row under the header, staying visible when the project is folded only while it is pinned; settled threads stay in one list. Groups keep a fixed order that activity never changes; right-click a group header to move it. Upstream's beta Working section applies only to the ungrouped list; a grouped list keeps busy threads in their project.
- A globe on a sidebar thread, including threads you are not viewing, shows it has a browser tab open. It turns blue and pulses ("Agent using browser") while that thread's agent is working, so you can jump in and watch or steer browser checks. It cannot see individual browser calls, so a thread that opened a tab and moved on to other work keeps pulsing until its turn ends or the tab closes.
- Per-thread Claude output style.
- A setting to stop threads naming themselves from their first message (Settings, General, "Generate thread titles").
- Browser previews close once a thread settles.
- A notification toast for a thread that wants an answer stays up instead of fading after a few seconds, and several show as a readable list rather than a collapsed pile. It appears even if the question arrived while the window was in the background, and comes back after a restart for any thread still waiting. It clears when you open that thread, use its "Open thread" button, or the thread stops waiting (answered anywhere, even while this client was disconnected, or failed). Failures still fade on their own, and a finished thread gets its sound and background popup but no toast.

### Browser automation

- Snapshots leave out a page's `console.debug` lines, so its errors stay among the console entries a snapshot keeps.
- `preview_wait_for`, `preview_navigate` and the action tools (click, type, hover, select, drag, upload) give up before the server does, so a condition or element that never appears returns an error instead of dropping the shared browser host for every thread.
- In the desktop app, an agent can drive a browser tab nobody is looking at: snapshots, clicks, key presses, resizes, animations and recordings work as if the tab were shown. While the agent acts, the tab draws through a single, nearly invisible pixel in the window's top-left corner, and when it stops the tab goes back to sleep.
- A snapshot whose screenshot cannot be taken within 5 seconds still returns the page's text, with a note saying the image is missing, and a stuck browser action no longer blocks every later action on that tab (upstream issue [#16567](https://github.com/pingdotgg/t3code/issues/16567)).
- In the desktop app, an agent's typing and key presses go only to the page, never to your own T3 window, including fields inside another site's iframe such as Stripe card fields. A key that cannot be delivered fails the tool instead of going anywhere else. An agent's click no longer takes keyboard focus away from what you were typing in.

### Fixes

- Git remotes whose URL contains a space are read correctly.
- Database backups and `t3 service install` work on Windows (file flush fixes).
- A failed bootstrap teardown no longer crashes the desktop backend.
- The project favicon path uses POSIX separators on Windows.
- The Claude usage pill follows the account in use after you switch Claude logins, instead of keeping the old account's windows.
- Claude's newer task tools (create, update, list) fill the tasks drawer, as `TodoWrite` did. Carried from open upstream PR [#14964](https://github.com/pingdotgg/t3code/pull/14964); drop it when that lands.
- A thread waiting on a background test or build can stay Working, and counted in its project's active number, until the command ends: press Wait on the background work strip, or an agent calls `wait_for_background_commands`. Taken from upstream PR [#15315](https://github.com/pingdotgg/t3code/pull/15315), which upstream closed unmerged; the fork keeps it.
- Preview tool waits are capped at 45 seconds so they finish inside the agent's 60 second tool-call limit.
- The desktop window keeps its size and position across every restart on scaled Windows displays, instead of falling back to the default size when Windows nudged it a few pixels past the screen edge.

### Windows test suite

Upstream CI does not run on Windows. The fork adds 8.3 `TEMP` path handling and other test fixes so the server suite runs here. A few upstream tests still fail on Windows for reasons outside the fork.

## Building

Node.js 24 and a recent `rustup` toolchain:

```bash
pnpm install
pnpm dist:desktop:win
```

The installer lands in `release/`. A local build replaces an installed official build, and a rebuild of the same version overwrites the previous installer. Copy `.env.example` to `.env` first to build with T3 Connect (remote access and phone alerts); without it, cloud features are off. Let Connect install its own cloudflared rather than installing one system-wide.

## Links

- [Upstream README](./README.upstream.md), a verbatim copy
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- [Documentation](./docs)
- [Discord](https://discord.gg/jn4EGJjrvv)
