# T3 Code, S&S Cooling Fork

My working fork of [T3 Code](https://github.com/pingdotgg/t3code). It is my daily driver, not a release channel. For the real project, read [the upstream README](./README.upstream.md) or go to [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

> **_NOTE_**
> Nothing here is an official build. Upstream ships at [t3.codes](https://t3.codes) and on [GitHub Releases](https://github.com/pingdotgg/t3code/releases).

The branch is `kevlingo/features`, kept current by merging upstream `main`. When upstream ships something that does the same job as a fork feature, upstream wins and the fork feature is removed.

## What the fork adds

### Agent orchestration

Behind the **Agent orchestration** setting, off by default:

- MCP tools that let one session drive others: `session_spawn`, `session_list`, `session_wake`, `session_settle`, `session_rename`, `session_models`, `session_projects`.
- `session_spawn` can pick the provider, model and reasoning effort, and can start work in any project on the server.
- Spawned sessions record the thread that spawned them. Settling an orchestrator settles what it spawned.
- `session_spawn` with `handoff` replaces a long-running orchestrator: the successor becomes its sibling and takes over every session it spawned, so the old one can be settled. The successor is pinned automatically, in the old one's pinned slot if it had one. A client reading the old orchestrator when it hands off follows to the successor.
- The command palette's "New thread in..." takes a count, so `fleet 5` starts five sessions at once.

### Chat and composer

- Mermaid diagrams in chat, with pan and zoom, cached across thread switches. From closed upstream PR [#4989](https://github.com/pingdotgg/t3code/pull/4989).
- Generated or changed images get their own work log row, kept visible when the work log folds. From closed upstream PR [#5114](https://github.com/pingdotgg/t3code/pull/5114).
- A plan usage pill in the composer, showing how much of the current plan window is used.
- An agents row in the composer activity banner, with Tasks and Agents tabs that keep one height and hide once work settles.
- The tasks banner stays up after you interrupt a turn.
- The Monitoring banner names the background command or watch it is waiting on, and shows how long it has been running.
- Stopped turns are marked in the transcript.
- The question panel scales with the appearance font size.
- The chat releases its scroll anchor when a turn settles, so the final reply is not stranded above blank space. Remove when upstream issue #5903 closes.

### Threads and sidebar

- A setting to group the sidebar by project (Settings, Appearance, "Group threads by project"). Each project folds and shows how many of its threads are working; settled threads stay in one list. Groups keep a fixed order that activity never changes; right-click a group header to move it.
- A globe on sidebar rows that pulses while an agent is using the browser.
- Plan progress as a meter on thread hover.
- Per-thread Claude output style.
- A setting to stop threads renaming themselves.
- Browser previews close once a thread settles.
- A notification toast for a thread that wants an answer stays up instead of fading after a few seconds, and several stack. It clears when you open that thread, use its "Open thread" button, or the question is answered anywhere. Completions and failures still fade on their own.

### Browser automation

- Snapshots work on background tabs that are not painted on screen.
- Smaller snapshots: a compacted accessibility tree without text-only nodes, and an `include` option to ask for only some sections.
- A stuck browser request no longer leaves the globe on.
- `preview_wait_for` gives up before the server does, so a condition that never matches returns an error instead of dropping the browser host.

### Fixes

- Git remotes whose URL contains a space are read correctly.
- Database backups and `t3 service install` work on Windows (file flush fixes).
- A failed bootstrap teardown no longer crashes the desktop backend.
- The project favicon path uses POSIX separators on Windows.
- Old rate limit rows are pruned from thread activity.
- A Claude question asked while the agent was working on its own stays open when another session's message arrives, instead of vanishing and leaving the agent stuck.
- A question whose agent died (a crash or restart) clears instead of locking the thread forever. From open upstream PR [#10586](https://github.com/pingdotgg/t3code/pull/10586).

### Windows test suite

Upstream CI does not run on Windows. The fork adds `.cmd` forms of the fake provider CLIs, 8.3 `TEMP` path handling, `core.autocrlf` pinning and other test fixes so the server suite runs here. A few upstream tests still fail on Windows for reasons outside the fork.

## Building

Node.js 24 and a recent `rustup` toolchain:

```bash
pnpm install
pnpm dist:desktop:win
```

The installer lands in `release/`. A local build replaces an installed official build, and a rebuild of the same version overwrites the previous installer. There is no `.env`, so cloud features do not work in a local build.

## Links

- [Upstream README](./README.upstream.md), a verbatim copy
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- [Documentation](./docs)
- [Discord](https://discord.gg/jn4EGJjrvv)
