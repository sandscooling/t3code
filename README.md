# T3 Code, S&S Cooling Fork

My working fork of [T3 Code](https://github.com/pingdotgg/t3code). It is my daily driver, not a release channel. For the real project, read [the upstream README](./README.upstream.md) or go to [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

> **_NOTE_**
> Nothing here is an official build. Upstream ships at [t3.codes](https://t3.codes) and on [GitHub Releases](https://github.com/pingdotgg/t3code/releases).

The branch is `kevlingo/features`, kept current by merging upstream `main`. When upstream ships something that does the same job as a fork feature, upstream wins and the fork feature is removed.

## What the fork adds

### Agent orchestration

Behind the **Agent orchestration** setting, off by default:

- MCP tools that let one session drive others: `session_spawn`, `session_list`, `session_wake`, `session_settle`, `session_models`, `session_projects`.
- `session_spawn` can pick the provider, model and reasoning effort, and can start work in any project on the server.
- Spawned sessions record the thread that spawned them. Settling an orchestrator settles what it spawned.
- The command palette's "New thread in..." takes a count, so `fleet 5` starts five sessions at once.

### Chat and composer

- Mermaid diagrams in chat, with pan and zoom, cached across thread switches. From closed upstream PR [#4989](https://github.com/pingdotgg/t3code/pull/4989).
- Generated or changed images get their own work log row, kept visible when the work log folds. From closed upstream PR [#5114](https://github.com/pingdotgg/t3code/pull/5114).
- A plan usage pill in the composer, showing how much of the current plan window is used.
- An agents row in the composer activity banner, with Tasks and Agents tabs that keep one height and hide once work settles.
- The tasks banner stays up after you interrupt a turn.
- Stopped turns are marked in the transcript.
- The question panel scales with the appearance font size.
- A setting to hide the message minimap beside the chat (Settings, General, "Show message minimap").
- The chat releases its scroll anchor when a turn settles, so the final reply is not stranded above blank space. Remove when upstream issues #4619 and #5903 close.

### Threads and sidebar

- A setting to group the sidebar by project (Settings, Appearance, "Group threads by project"). Each project folds and shows how many of its threads are working; settled threads stay in one list.
- A globe on sidebar rows that pulses while an agent is using the browser.
- Plan progress as a meter on thread hover.
- Per-thread Claude output style.
- A setting to stop threads renaming themselves.
- Browser previews close once a thread settles.

### Browser automation

- Snapshots work on background tabs that are not painted on screen.
- Smaller snapshots: a compacted accessibility tree without text-only nodes, and an `include` option to ask for only some sections.
- A stuck browser request no longer leaves the globe on.

### Fixes

- Git remotes whose URL contains a space are read correctly.
- Database backups and `t3 service install` work on Windows (file flush fixes).
- A failed bootstrap teardown no longer crashes the desktop backend.
- The project favicon path uses POSIX separators on Windows.
- Old rate limit rows are pruned from thread activity.

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
