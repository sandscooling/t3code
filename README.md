# T3 Code, S&S Cooling Fork

My working fork of [T3 Code](https://github.com/pingdotgg/t3code). It is my daily driver, not a release channel. For the real project, read [the upstream README](./README.upstream.md) or go to [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

> **_NOTE_**
> Nothing here is an official build. Upstream ships at [t3.codes](https://t3.codes) and on [GitHub Releases](https://github.com/pingdotgg/t3code/releases).

The branch is `kevlingo/features`, kept current by merging upstream `main`. When upstream ships something that does the same job as a fork feature, upstream wins and the fork feature is removed.

## What the fork adds

### Agent orchestration

Always available to every agent session, with no setting to turn on:

- MCP tools that let one session drive others: `session_spawn`, `session_list`, `session_wake`, `session_settle`, `session_rename`, `session_models`, `session_projects`. `session_list` reports each session as `running`, `monitoring` (its turn ended but a watch or background command is still going), or `ready`.
- `session_spawn` can pick the provider, model and reasoning effort, and can start work in any project on the server.
- Spawned sessions record the thread that spawned them. Settling an orchestrator settles what it spawned.
- `session_spawn` with `handoff` replaces a long-running orchestrator: the successor becomes its sibling and takes over every session it spawned, so the old one can be settled. The successor is pinned automatically, in the old one's pinned slot if it had one. A client reading the old orchestrator when it hands off follows to the successor.
- `session_spawn` can attach a session to an existing git worktree you created, by path and branch or by naming a session already in it; a handoff successor stays in its predecessor's worktree. T3 never creates, recreates, or deletes these attached worktrees.
- The command palette's "New thread in..." takes a count, so `fleet 5` starts five sessions at once.
- Each project can mark its orchestrator's sidebar card with a colored bar down its left edge. Right-click the orchestrator, or the project header when threads are grouped by project, and pick "Orchestrator color". A thread counts as the orchestrator once it spawns a session or is named exactly `Orchestrator`, and a handoff successor keeps the color. The choice is saved on this device only.

### Chat and composer

- Mermaid diagrams in chat, with pan and zoom, cached across thread switches. From closed upstream PR [#4989](https://github.com/pingdotgg/t3code/pull/4989).
- Images an agent generates or views (a Codex generated image, a Read of a png) get their own work log row, show without expanding it, and stay out of the "+N tool calls" fold. From closed upstream PR [#5114](https://github.com/pingdotgg/t3code/pull/5114).
- An answered question stays out of the "+N tool calls" fold, so the tool calls after it cannot hide it.
- A plan usage pill in the composer, showing how much of the current plan window is used.
- The background work banner shows how long the newest command or watch has been running.

### Threads and sidebar

- A setting to group the sidebar by project (Settings, Appearance, "Group threads by project"). Each project folds and shows how many of its threads are working or monitoring, and a project's orchestrator leads its group as the first row under the header, staying visible when the project is folded only while it is pinned; settled threads stay in one list. Groups keep a fixed order that activity never changes; right-click a group header to move it. Upstream's beta Working section applies only to the ungrouped list; a grouped list keeps busy threads in their project.
- A globe on sidebar rows that pulses while an agent is using the browser.
- Plan progress as a meter on thread hover.
- Per-thread Claude output style.
- A setting to stop threads renaming themselves.
- Browser previews close once a thread settles.
- A notification toast for a thread that wants an answer stays up instead of fading after a few seconds, and several show as a readable list rather than a collapsed pile. It appears even if the question arrived while the window was in the background, and comes back after a restart for any thread still waiting. It clears when you open that thread, use its "Open thread" button, or the thread stops waiting (answered anywhere, even while this client was disconnected, or failed). Failures still fade on their own, and a finished thread gets its sound and background popup but no toast.

### Browser automation

- Snapshots work on background tabs that are not painted on screen.
- Smaller snapshots: a compacted accessibility tree without text-only nodes.
- A stuck browser request no longer leaves the globe on.
- `preview_wait_for` gives up before the server does, so a condition that never matches returns an error instead of dropping the browser host.

### Fixes

- Git remotes whose URL contains a space are read correctly.
- Database backups and `t3 service install` work on Windows (file flush fixes).
- A failed bootstrap teardown no longer crashes the desktop backend.
- The project favicon path uses POSIX separators on Windows.
- The Claude usage pill follows the account in use after you switch Claude logins, instead of keeping the old account's windows.
- Claude's newer task tools (create, update, list) fill the tasks drawer and the hover progress meter, as `TodoWrite` did. Carried from open upstream PR [#14964](https://github.com/pingdotgg/t3code/pull/14964); drop it when that lands.
- Agents are told to wrap image paths that contain spaces in angle brackets, so the image renders instead of showing as text. Remove when upstream renders spaced image paths itself (its fix, PR [#12815](https://github.com/pingdotgg/t3code/pull/12815), closed unmerged).
- Preview tool waits are capped at 45 seconds so they finish inside the agent's 60 second tool-call limit, and a browser host reset by a timeout reports that it is reconnecting instead of telling the agent to give up.

### Windows test suite

Upstream CI does not run on Windows. The fork adds `.cmd` forms of the fake provider CLIs, 8.3 `TEMP` path handling, `core.autocrlf` pinning and other test fixes so the server suite runs here. A few upstream tests still fail on Windows for reasons outside the fork.

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
