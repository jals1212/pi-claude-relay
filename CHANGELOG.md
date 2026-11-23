# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.3.0

### Added

- The footer status shows when each usage window resets: `Claude 5h 63% (resets in 52m) · 7d 74% (resets in 8h 12m)`. Before, the reset time appeared only for a warning or a reached limit. Two settings in the `/claude-relay` menu shape it. **Reset time in status bar** (`/claude-relay reset when always|near|never`) chooses when: `always` (default), only `near` a limit (Claude's warning state; just the window near its limit), or `never`. **Reset time format** (`/claude-relay reset format full|compact`) chooses how: `full` (default) or `compact` (`Claude 5h 63% ↻52m · 7d 74% ↻8h 12m`). Saved per Pi space as `status.resetWhen` and `status.resetFormat` in `claude-relay-settings.json`. A reached limit always shows its reset time. The reset times are recomputed from the current time whenever the footer is repainted.
- **Status bar label** in the `/claude-relay` menu or `/claude-relay label [claude|relay|spark]`: the usage line starts with `Claude` (default), the relay symbol `⎍` or the Claude spark `✻` (`⎍ 5h 63% ↻52m · 7d 74% ↻8h 12m`, `⎍ limit reached · …`). Saved per Pi space as `status.label`. The login line and the pop-ups are not affected.

## 0.2.1

No changes to the code: it is the same as 0.2.0.

### Changed

- README: a **Settings file** reference with the whole `claude-relay-settings.json`, every key with its default, the command that sets it and its effect, and how the file is written and read. The settings menu section now says the mouse wheel scrolls and a click selects, as in Pi's `/settings`.

## 0.2.0

### Added

- Setting to hide the Claude usage (`Claude 5h 48% · 7d 73%`) from the footer status: **Usage in status bar** in the `/claude-relay` menu or `/claude-relay status [on|off]` (on by default, saved per Pi space as `status.usage` in `claude-relay-settings.json`). Off shows the login line (`✓ Claude relay · subscription` / `API key`) instead, at once; on shows the last usage seen at once, or at the next response. The usage warning and limit pop-ups are not affected.
- `/claude-relay` with no arguments opens a settings menu in the style of Pi's `/settings`: the two usage pop-ups and latency timing as on/off toggles that are saved at once, plus read-only views of the prompt-cache stats and the latency summary. Without an interactive UI it prints the usage line as before; `notify`, `stats` and `timing` keep working as text commands. The menu loads `@earendil-works/pi-tui` lazily, so the package now declares it as an optional peer dependency.
- Opt-in latency timing: `/claude-relay timing [on|off]` (off by default, saved per Pi space as `timing` in `claude-relay-settings.json`). While on, each settled request appends one content-free JSON line (marks in ms: process start, first `claude` line, first thinking, first text or tool call, stop, settle, plus model, output tokens, stop reason and restart reason) to `claude-relay-timing.jsonl` next to the settings, written asynchronously after the request. `/claude-relay timing` shows the state and the median and p90 of the last 500 requests. Off costs one boolean check per request.

### Fixed

- An exhausted Claude usage window (the 5-hour or weekly limit) is no longer retried by Pi. The relay worded it `429 rate limit: …`, which Pi retries with a backoff of at most a minute, so every hit started `claude` again 7–9 times in under a minute for a limit that resets in hours. It is now worded `429 quota exceeded: …`, which Pi fails at once; transient rate limits keep the retryable `429 rate limit: …` wording. Only a `rejected` rate-limit event seen for the same request counts: one left over from an earlier request no longer marks a later, unrelated error.

## 0.1.5

### Fixed

- A Pi tool that runs longer than 5 minutes (a native review, a CI wait, a subagent) is no longer cut by `claude`. `claude` aborts an HTTP MCP call that sends no response or progress for 5 minutes (`sent no response or progress for 300s; aborting`) even with `MCP_TOOL_TIMEOUT` set, because that variable is only the wall-clock limit. The relay now sets a per-call `timeout` of 24 hours in its MCP config and `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, and drops an inherited `CLAUDE_AUTO_BACKGROUND_TASKS`.
- A Pi session no longer hangs forever after `claude` gives up on a tool call. Before, `claude` went on without the result: it answered the cut call with an error and ended its turn on its own. When Pi later delivered the result, it went to a call nobody waited for, and Pi waited for a reply that never came. Now the relay notices when `claude` stops waiting for a parked call: it closes the request, sends `notifications/cancelled`, or ends its turn while Pi still runs the tool. The relay then stops that `claude` at once, and the result restarts it with a transcript replay (restart reason `missing-tool-call`). A request already waiting on the call restarts within that same request, or fails with a message if part of its answer had already reached Pi.

## 0.1.4

### Fixed

- Background notices no longer restart `claude` and replay the whole conversation. Pi turns each extension notice into its own user message, and a finished subagent or background job usually adds two at once (a result and its wake-up notice). The relay continued the live session only for exactly one new user message, so every such notice started a new `claude` session with a flattened transcript: the prompt cache of the conversation was lost and the whole history was written to the cache again, often 250k–330k tokens per notice. Several user messages in a row, after a finished turn or after the tool results, are now sent to the live process together as one user line.

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
