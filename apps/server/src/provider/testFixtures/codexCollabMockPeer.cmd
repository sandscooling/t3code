@echo off
rem Wrapper so CodexSessionRuntime can spawn the mock peer on Windows, which
rem cannot execute the .sh sibling. The runtime passes "app-server" first (a
rem real codex CLI subcommand); the peer ignores argv, so it is forwarded as-is
rem rather than shifted, which batch cannot do to %*.
node "%~dp0codexCollabMockPeer.mjs" %*
