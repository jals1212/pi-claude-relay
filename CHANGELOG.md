# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.1.3

### Fixed

- A turn no longer fails with `Claude called a tool Pi did not offer: <name>` when the model calls a tool name that does not exist, such as a made-up `mcp__pi__notification`, a doubled prefix (`mcp__pi__mcp__pi__subagent_parent_message`) or a bare `Bash`. `claude` answers such a call itself with `No such tool available` and the model tries again, as it already did for an offered tool called by its bare name; the relay now drops the call and continues the turn. The call never reaches Pi. A turn drops at most 3 such calls; the 4th fails it with the same message, so a model stuck on a wrong name cannot loop. A renamed name that two offered tools share still fails the turn.

## 0.1.2

No changes to the package itself: its code is the same as 0.1.1.

### Changed

- First release staged by the release workflow through npm trusted publishing, so the package carries a provenance statement. 0.1.0 and 0.1.1 were published by hand, without one.

## 0.1.1

### Fixed

- A turn no longer fails with `Claude called a tool Pi did not offer: <name>` when Claude calls an offered Pi tool by its bare name (without the `mcp__pi__` prefix). `claude` answers that call itself with `No such tool available` and the model tries again; the relay now drops the call and continues the same turn with Claude's next message, adding up the usage of both. Names Pi did not offer still fail the turn.
- Pi tools whose name has characters outside letters, digits, `_` and `-` (for example `weird.name`) now work. `claude` renames them (`mcp__pi__weird_name`); the relay allowed and looked up the original name, so the call was denied or failed with `Claude called a tool Pi did not offer`. A renamed name that two offered tools share is not guessed and still fails the turn.

## 0.1.0

First release.

### Added

- Relay of Pi's built-in `anthropic` provider through the official `claude` CLI (stream-json). Models keep their normal ids; Pi's model catalog and auth are untouched.
- One long-lived `claude` process per Pi session, so several sessions and subagents run in parallel without sharing state. No orphan processes on session end or Pi exit.
- Per-space login: `claude` gets only the Anthropic credential Pi resolves for the current Pi space (OAuth token or API key) and keeps its state in `<agent home>/claude-relay`. The shared `~/.claude` login and inherited `ANTHROPIC_*`, `CLAUDE_CODE_*` and `CLAUDE_CONFIG_DIR` variables are never used. A space without an Anthropic login fails with a `/login` hint.
- Pi tools served to Claude through a per-session loopback MCP server with parked tool calls. Top-level `anyOf`/`oneOf`/`allOf` tool schemas are flattened into one object schema.
- Prompt-cache preservation:
  - Abort sends `claude` an `interrupt` instead of killing it; the next message continues on the same process.
  - A replaced process (credential refresh, effort, tool-set or model change, crash) resumes `claude`'s own session with `--resume`, keeping the cache and the structured history. A flattened transcript replay is the fallback for a diverged history (compaction, branch switch, edited history), a pending tool call, a changed system prompt, or a failed resume.
  - Pi's idle cache-warming requests are answered locally, and one-off requests (compaction, summaries) use a throwaway process that is closed when they finish.
- Thinking levels map to `claude --effort`; thinking blocks reach Pi with their summarized text (`--thinking-display summarized`).
- `/claude-relay stats`: turns, cache hit rate, `claude` process starts, restarts by reason, resumed restarts, cache-warm requests answered locally and one-off requests. `PI_CLAUDE_RELAY_DEBUG_LOG=<file>` appends one JSON line per turn (no prompt text, credentials or MCP URL).
- Cost per response computed from the reported tokens with Pi's own model rates (`calculateCost`), including 1 h cache writes, so Pi's cost footer and usage stats work.
- Footer status from session start with the relay and the space's login; Claude usage windows with a reset countdown, colored through Pi's theme (`warning` above 70 %, `error` above 90 %).
- Claude rate-limit events exposed as `anthropic-ratelimit-unified-*` response headers and notifications; limit errors are worded so Pi's retry logic recognizes them.
- `/claude-relay notify [warning|limit] [on|off]`: two independent switches for the usage pop-ups, saved per Pi space.
- Actionable errors when the `claude` CLI is missing or older than 2.1.330.
- `PI_CLAUDE_RELAY=off` to fall back to Pi's direct Anthropic streaming; `PI_CLAUDE_RELAY_CLAUDE_BIN` to choose the `claude` binary.

### Security

- The system prompt and the MCP config (with its secret URL) reach `claude` through `0600` files in a private temp directory, never through the command line.
- The loopback MCP server checks its path token in constant time, rejects foreign `Host` headers and any `Origin` header, caps request bodies, and never throws on malformed input.
- Tool calls for tools Pi did not offer are rejected; malformed `claude` output fails the turn instead of crashing Pi.
- The credential and the MCP URL are redacted from `claude` error text.
- A replayed transcript escapes its envelope, so tool output cannot pose as a user turn.
