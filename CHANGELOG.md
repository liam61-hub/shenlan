# Changelog

## [0.5.0] — 2026-11-01

### Added

- A unified subtask tree with grouped development, verification, documentation and commit items, plus progress reconciliation reminders.
- Immediate execution records for supported test, build and commit commands, preserving test summaries, failures and commit hashes.
- Explicit Plan-to-implementation permission selection, including a fallback when a plan ends without a handoff tool call.

### Improved

- Coalesce consecutive reads while updating the current file, and compact repeated ordinary shell output.
- Improve conversation headings, status colors, terminal layout and sub-agent progress reporting.
- Cache development-launcher build checks and keep ordinary keystrokes local to the input component.
- Preserve explicit permission denials and reject compound shell syntax in Plan mode.


> Public changelog since v0.4.0. Earlier versions were internal.

## [0.4.90] — 2026-10-05

### Key changes

- Refined the startup header logo: shortened the hair glyph and condensed the status area from four lines to three while keeping the overall header height stable.

### Package versions

- `@shenlan/cli`: 0.4.89 → 0.4.90
- `@shenlan/core`: unchanged at 0.3.33

---

## [0.4.89] — 2026-10-05

### Key changes

- Fixed output-budget exhaustion for reasoning models. Reasoning tokens previously shared the output allowance with the response body and could consume it entirely at the default `maxTokens`, leaving replies empty. Introduced `resolveMaxOutputTokens` with configurable floors (`model.maxOutputTokens`, `context.thinkingOutputFloor`) so reasoning never starves the response.
- Handled truncation (`finish_reason=length`) by scenario: truncated tool calls and reasoning-only output retry with a raised budget; a truncated response body is kept and continued. When the endpoint rejects the raised budget, the configured baseline is restored to avoid retry loops. Headless `shenlan run` follows the same budget logic.
- Redrew the header logo using background-color blocks instead of block glyphs, eliminating missing-glyph rendering issues across terminals.

### Package versions

- `@shenlan/cli`: 0.4.88 → 0.4.89
- `@shenlan/core`: 0.3.32 → 0.3.33

---

## [0.4.88] — 2026-09-17

### Key changes

- Provider model discovery now drives the setup wizard and `/keys`: seven provider presets were unified into a single source of truth (`PROVIDER_PRESETS`); models are probed via `/v1/models` before selection, and `providerModels` records model ownership to prevent cross-provider key misuse.
- Improved TUI information flow and line-wrap stability: completed tool steps freeze into the terminal scrollback, user messages render as inverse blocks, assistant replies use a continuous gutter line that no longer breaks on CJK/narrow terminals, and layout drift from separator lines and async notices was fixed.
- Reduced security-scan noise: `security scan --staged` scans only newly added lines, while hard-blocked paths remain enforced.
- Hardened path safety: `isPathSafe` compares literal roots against resolved realpaths, fixing misjudgment when the project directory itself is a symlink, and Windows junction escapes are covered.

### Package versions

- `@shenlan/cli`: 0.4.87 → 0.4.88
- `@shenlan/core`: 0.3.31 → 0.3.32

---

## [0.4.87] — 2026-09-15

### Key changes

- Completed the memory system: token-budgeted injection (`context.maxMemoryTokens`) with folding of overflow entries; hot refresh so memories saved via `memory_save` take effect on the next turn without `/clear`; four-layer rule discovery (org opt-in / user / project / personal) with hard boundaries and `paths:` conditional rules; `/memory edit` and recursive `@import` with cycle detection.
- Fixed cost-guardrail accounting: models without built-in prices now use tier-based fallback estimates instead of ¥0, so guardrails can intercept sessions that would otherwise go unmeasured; `/cost` and `/budget` surface estimate warnings.
- Fixed a cost-first routing unit error that could systematically favor unpriced models.
- Added default endpoints for doubao/zhipu/kimi, so `glm-*` and similar prefixes no longer fail with "no base URL configured".
- Added a drift guard for the product-site model page and integrated the vision e2e script into the test runner.

### Package versions

- `@shenlan/cli`: 0.4.86 → 0.4.87
- `@shenlan/core`: 0.3.30 → 0.3.31

---

## [0.4.86] — 2026-09-08

### Key changes

- Added the interactive `/config` panel: browse every config key with its value and comment, toggle booleans/enums with ←/→, edit values inline with Enter, reset with `d`, and switch global/project scope with `g`/`p`. Changes apply to the running session immediately.
- Added a `language` config option (`en` default, `zh-CN` available) that switches configuration comments, environment-variable descriptions, and panel text on the fly.
- Replies now follow the language of the user's most recent message across the main loop, sub-agents, goal mode, and headless runs.
- Added the headless `shenlan config get|set|unset` command, equivalent to `/config`.
- Added a lightweight binary entry so `--version`/`--help` no longer load the full React/Ink stack (warm start 0.87s → 0.08s).
- Repositioned the documentation around the local-first, bring-your-own-key agent workspace.

### Package versions

- `@shenlan/cli`: 0.4.85 → 0.4.86
- `@shenlan/core`: 0.3.29 → 0.3.30

---

## [0.4.85] — 2026-09-05

### Key changes

- Pinned `@shenlan/cli`'s dependency on `@shenlan/core` to an exact version so release artifacts stay aligned with the repository.

### Package versions

- `@shenlan/cli`: 0.4.84 → 0.4.85

---

## [0.4.84] — 2026-09-05

### Key changes

- Any OpenAI-compatible model now works out of the box: custom provider entry in the setup wizard and `/keys` (base URL → key → model name), `OPENAI_API_KEY` support with the legacy `GPT_API_KEY` alias, openai-family prefix mapping, and explicit errors for unknown providers without a base URL.
- Vision support: multimodal content parts (`image_url`) with direct first-round image passing, sticky upgrade when images arrive mid-session, and a corrected qwen-vl-max context window (32k → 131072).
- Unified the model catalog into a single source of truth (`core/src/model-catalog.ts`) driving routing, prices, wizard lists, and the README model table; OpenAI models joined the catalog.
- Price sync now adds and updates models from the official API instead of only updating known ones.
- Protocol mapping: o-series models use `max_completion_tokens` instead of `max_tokens`.
- Documentation: the README model table is generated via `npm run docs:models` with a drift-guard test, third-party integration guidance was added, and a new user guide (`docs/user-guide.md`) covers routing, permissions, cost budgets, and extensions.

### Package versions

- `@shenlan/cli`: 0.4.83 → 0.4.84
- `@shenlan/core`: 0.3.28 → 0.3.29

---

## [0.4.83] — 2026-08-30

### Key changes

- Fixed input-line shifting while typing on Windows terminals: input lines are windowed horizontally (cursor always visible, overflow indicator), no rendered line ever spans the full terminal width, and display-width accounting now correctly counts CJK characters — eliminating the frame drift that triggered full-screen clears.

### Package versions

- `@shenlan/cli`: 0.4.82 → 0.4.83

---

## [0.4.82] — 2026-08-29

### Key changes

- Added a schema-driven `/config` command (`get|set|unset`, sensitive masking, Tab completion) backed by `config-schema.ts`.
- Added the optional `tavily_search` tool (`tavily.enabled`, off by default), sharing key resolution with the `web_search` fallback.
- Added the background Explore agent: asynchronous dispatch with a concurrency limit, a session-level registry, single-injection results, and a status line in the dynamic region.
- Added the action safety net: high-risk command double confirmation, `protectedPaths` interception for write/edit, action-level audit events (`.shenlan/audit.jsonl`), and a read-only command whitelist in plan mode.
- Added structured pitfall memory with hard pre-action blocks, hit counting, auto-recording from known errors, and `/pitfall` listing and import.
- Model and provider bundle: LLM task-classified routing, `view_image`, `transcribe_media` with pluggable runners, DeepSeek balance pre-check, and optional provider failover.
- Hardened networking: `web_fetch` error causes with automatic retry, one automatic retry for transient network failures on LLM calls, and debug logs on error paths.
- Added cross-platform dev launcher scripts.

### Package versions

- `@shenlan/cli`: 0.4.81 → 0.4.82
- `@shenlan/core`: 0.3.27 → 0.3.28

---

## [0.4.81] — 2026-08-27

### Key changes

- Fixed web search routing to follow the actually active model, and added dual-path native search for qwen (Responses API for Max models, streaming Chat Completions for plus models) with timeout fallbacks.
- Added the bailian (DashScope) provider for hosted model access with its own endpoints and search path.
- Grouped the `/model` panel by source endpoint (auto routing / DeepSeek official / DashScope).
- Finalized the header logo design.

### Package versions

- `@shenlan/cli`: 0.4.80 → 0.4.81
- `@shenlan/core`: 0.3.26 → 0.3.27

---

## [0.4.80] — 2026-08-26

### Key changes

- Onboarding and key management: first-run three-step onboarding (welcome → key setup → quick start), a `/keys` panel with masked display and connectivity checks, config files tightened to 0600 permissions, and unified API error classification with actionable hints.
- Commit-time security scanning: a nine-rule secret scanner plus hard-blocked paths (`.shenlan/config.json`, `.env*`), `shenlan security` subcommands, and a silent pre-commit hook installer.
- Flexible cost guardrails and `/goal` long-task mode: 60%/80% tiered warnings, a three-way dialog when a limit is hit (stop / waive / raise the limit), and a goal loop that auto-continues until the goal completes or stalls.
- `.env` loading (`cwd/.env` and `~/.shenlan/.env`) with real environment variables taking precedence, plus auto-generated config directories with samples.
- Documentation: rewrote the README around a 3-minute first-use path and five key configuration methods.

### Package versions

- `@shenlan/cli`: 0.4.79 → 0.4.80
- `@shenlan/core`: 0.3.25 → 0.3.26

---

## [0.4.79] — 2026-08-25

### Key changes

- Project config no longer overwrites the global model choice when it only contains the legacy default template.
- Normalized DashScope Anthropic endpoint URLs to the OpenAI-compatible endpoint automatically.
- `/model auto` now returns to the configured default model instead of a hardcoded one.
- Added the qwen3.7 / qwen3.8 families to the catalog with tier-aligned routing.

### Package versions

- `@shenlan/cli`: 0.4.78 → 0.4.79
- `@shenlan/core`: 0.3.24 → 0.3.25

---

## [0.4.78] — 2026-08-25

### Key changes

- Multi-provider model routing: qwen joined the catalog; cost-first routing picks the cheapest model for routine tasks and the strongest for coding, reasoning, and long contexts, with quality-first and manual strategies and persistence.
- Pricing system: manual/auto/builtin tiers with `/prices` and `/prices check` for official syncs.
- Provider-ized configuration: `providerBaseUrls` / `routing` keys and three-level base-URL resolution.
- Multi-provider setup wizard: select DeepSeek and/or qwen, test each provider's connectivity, and merge updates on re-runs.
- Native web search for qwen via DashScope's OpenAI-compatible endpoint; other models keep the Tavily fallback.
- The UI now shows the actually routed model in the status line and header.

### Package versions

- `@shenlan/cli`: 0.4.77 → 0.4.78
- `@shenlan/core`: 0.3.23 → 0.3.24

---

## [0.4.77] — 2026-08-22

### Key changes

- Auto Memory: the model can save cross-session memories on its own (or on request) into plain-Markdown project/global scopes with a `MEMORY.md` index, hot-loaded per turn, with `/memory on|off|rm|open` management.
- Fixed inline-code backtick parsing across lines and in wrapped table cells.
- Slash-command autocomplete now scrolls its window around the selection.
- Improved `/model` and `/permissions` displays.

### Package versions

- `@shenlan/cli`: 0.4.76 → 0.4.77
- `@shenlan/core`: 0.3.22 → 0.3.23

---

## [0.4.76] — 2026-08-22

### Key changes

- Message tables restyled: no box borders, bold cyan headers with a heavy rule, and light row separators.
- `/clear` now resets the viewport visually without emitting any clear-screen sequences, preserving scrollback history.
- Corrected the `agent` tool description and concurrency wording.

### Package versions

- `@shenlan/cli`: 0.4.75 → 0.4.76
- `@shenlan/core`: 0.3.21 → 0.3.22

---

## [0.4.75] — 2026-08-20

### Key changes

- Filled the logo face and added dot eyes for consistent rendering on light and dark terminals.

### Package versions

- `@shenlan/cli`: 0.4.74 → 0.4.75
- `@shenlan/core`: unchanged at 0.3.21

---

## [0.4.74] — 2026-08-19

### Key changes

- Slash-command autocomplete: typing `/` lists matching commands with descriptions, ↑/↓ select, Enter executes, Tab cycles, and Esc closes.
- CI green across platforms: test assertions tolerate detached HEAD, rendering tests force interactive mode, Windows path normalization fixes, and shell timeout tests adapted for cmd.exe.
- Session ids are now standard UUID v4.
- Polished the built-in create-skill with naming conventions, templates, and validation.
- Skills and MCP servers now show their source (built-in 🔒 / user / project) in panels and listings.
- `/clear` no longer emits clear-screen sequences: old content stays in the scrollback and the new session renders beneath it.

### Package versions

- `@shenlan/cli`: 0.4.73 → 0.4.74
- `@shenlan/core`: 0.3.19 → 0.3.21

---

## [0.4.73] — 2026-08-19

### Key changes

- Automated MCP configuration: `shenlan mcp list/add/remove/refresh` plus an in-session `/mcp` panel with connection status, tool counts, a detail view, and reconnect/disable/enable; `env:VAR` references keep keys out of config files.
- Hot MCP management: enable/disable/connect/disconnect without restart, with idempotent tool unregistration and clean subprocess shutdown on exit.
- Added a `/skills` panel and fixed custom skill-directory resolution (`config.skills` now works, `~` expansion, platform paths).
- Fixed stale todo/plan residue between tasks and rapid panel key handling.

### Package versions

- `@shenlan/cli`: 0.4.72 → 0.4.73
- `@shenlan/core`: 0.3.18 → 0.3.19

---

## [0.4.72] — 2026-08-17

### Key changes

- Cost guardrails with real usage accounting: costs are computed from API usage, enforced per-session and per-day, with `/cost`, `/budget`, and `costCny` in headless results.
- `/plan save` persists plans to `.shenlan/plans/` with metadata and step states.
- Added `todo_write` / `update_plan` tools with a minimal dynamic-region UI.
- Upgraded loop detection to semantic signatures to catch real repetition without false positives.
- Multiline input and paste: pastes keep newlines and never auto-submit; large pastes (≥20 lines) collapse into placeholders and expand on demand.
- ESC now aborts in-flight LLM requests immediately.
- Confirmation dialogs render inside the conversation flow, right below the last message.
- Shell commands that time out are moved to the background instead of killed, with `shell_status`/`shell_kill` to inspect them.
- Tool failures display as ordinary results instead of red errors.
- Added the `web_fetch` tool.

### Package versions

- `@shenlan/cli`: 0.4.71 → 0.4.72
- `@shenlan/core`: 0.3.17 → 0.3.18

---

## [0.4.71] — 2026-08-14

### Key changes

- Hardened exit paths: `/exit`, Ctrl+C/D, SIGTERM, and SIGHUP all flush session messages to disk first and print a resume hint; SIGTSTP suspends gracefully.
- Sessions now persist incrementally per message; `--resume` restores exactly what was on screen.
- Rewrote glob scanning to be async, bounded, and symlink-safe, with automatic search-directory detection for absolute patterns.
- Added file-change cards for write/edit operations in the scrollback.
- Fixed rapid typing and paste handling, restoring Enter/Tab/Backspace semantics under Ink 7.
- Streaming code blocks now freeze whole and render identically to completed messages.
- Added a PTY end-to-end suite (`packages/cli/e2e/`) covering exit, resume, suspend, signals, confirmation dialogs, and `/clear`, with no full-screen-clear regressions.

### Package versions

- `@shenlan/cli`: 0.4.70 → 0.4.71
- `@shenlan/core`: 0.3.16 → 0.3.17

---

## [0.4.70] — 2026-08-13

### Key changes

- Long tasks now behave like Codex/Claude Code CLI: the step limit is configurable (`agent.maxSteps`) and hitting it no longer errors — enter Continue to keep running. Loop detection injects a correction and gives one more chance before finishing gracefully.
- Context compression v2: the trigger threshold is configurable (`context.autoCompactTokenLimit`), the system prompt and recent turns are kept intact, middle history is summarized by the flash model into a structured handoff, and a rule-based summary takes over if the LLM fails.
- Added `/compact` and `/context` for manual compression and inspection.
- The tool-output ref threshold is now configurable (`context.toolOutputLimitChars`).
- Model routing is sticky within a session, and task-type detection keywords were expanded and fixed for Chinese input.
- Permission-mode switches take effect immediately at runtime.

### Package versions

- `@shenlan/cli`: 0.4.69 → 0.4.70
- `@shenlan/core`: 0.3.15 → 0.3.16

---

## [0.4.69] — 2026-08-12

### Key changes

- Fixed the DeepSeek 400 root cause in context compression: the retention window no longer splits tool-call/tool-response pairs, and a sanitizer repairs orphaned tool messages.
- Added a persistent status line under the input box (model · mode · working directory).
- Confirmation dialogs now support "tell me what to do differently" feedback that is fed back to the model, plus fine-grained command-prefix and file-path grants.
- Streaming tables and math blocks buffer until complete, then freeze as whole blocks.
- Tool results show as single-line summaries in the scrollback.
- Fixed markdown display-width accounting for emoji and ZWJ sequences, and added a render-memory guard against streaming OOM.
- Tool timeouts now truly abort the underlying work via AbortSignal.
- `~` expansion unified across read/write/edit/glob; the system prompt reports platform, shell, and encoding dynamically.
- Sub-agents get a 240s time budget and return partial results instead of being dropped.

### Package versions

- `@shenlan/cli`: 0.4.68 → 0.4.69
- `@shenlan/core`: 0.3.14 → 0.3.15

---

## [0.4.68] — 2026-08-12

### Key changes

- Native terminal scrollback (Claude Code style): history and completed streaming lines are written incrementally to the terminal's own scrollback; the mouse wheel and scrollbars are handled by the terminal again.
- Streaming output freezes line by line; only the unfinished line refreshes at the bottom.
- A dynamic frame height budget guarantees the rendered frame never exceeds the terminal height, eliminating full-screen clears.
- Codex-style confirmation dialog: a bordered modal with `$`/`✎` prefixes and three options (allow / deny / abort).
- Removed dead code from the previous virtual-viewport approach.

### Package versions

- `@shenlan/cli`: 0.4.67 → 0.4.68

---

## [0.4.67] — 2026-08-12

### Key changes

- All tools accept AbortSignal: shell and search kill their child processes on abort, web fetches merge external and internal timeouts, and MCP transports support cancellation.
- ESC aborts the running task; enter Continue to resume from the round boundary.
- Sub-agent rounds raised 5 → 20 with full debug logging.
- Path safety: read/write/edit can access absolute paths; symlink escape detection applies within the working directory only.
- Windows layout stability and cached git-branch lookups.
- Debug logs split per day with 7-day retention.

### Package versions

- `@shenlan/cli`: 0.4.66 → 0.4.67
- `@shenlan/core`: 0.3.13 → 0.3.14

---

## [0.4.66] — 2026-08-11

### Key changes

- Fixed duplicate input boxes on Windows caused by a missing flex-shrink constraint during streaming re-renders.

### Package versions

- `@shenlan/cli`: 0.4.65 → 0.4.66

---

## [0.4.65] — 2026-08-11

### Key changes

- Reverted fixed-scroll mouse takeover; text selection dragging restored.
- Completed markdown support: full-box tables with display-width alignment, math formulas rendered as readable Unicode, links, strikethrough, task lists, and blockquotes.
- Added cursor editing in the input box (←/→ move, Backspace/Delete, Home/End).

### Package versions

- `@shenlan/cli`: 0.4.64 → 0.4.65

---

## [0.4.64] — 2026-08-11

### Key changes

- Restored the compact layout so short conversations no longer leave a large gap between the logo and the input box.

### Package versions

- `@shenlan/cli`: 0.4.63 → 0.4.64

---

## [0.4.63] — 2026-08-11

### Key changes

- Fixed a startup crash (`stdin.ref is not a function`) introduced by the mouse-reporting wrapper.

### Package versions

- `@shenlan/cli`: 0.4.62 → 0.4.63

---

## [0.4.62] — 2026-08-11

### Key changes

- Markdown rendering completed: tables with aligned columns, code blocks with a left gutter and language label, and unified streaming/completed rendering.
- Fixed-window viewport with mouse-wheel takeover for scrollback review, so the rendered frame never exceeds the terminal height.
- Distinct role styles (user `❯`, assistant `│`, tool `↳`, system `ℹ`) and timestamp separators between rounds.

### Package versions

- `@shenlan/cli`: 0.4.61 → 0.4.62

---

## [0.4.61] — 2026-08-10

### Key changes

- Narrowed the shell tool description to running programs (builds, tests, git, npm) and trimmed tool outputs in the message area.

### Package versions

- `@shenlan/core`: 0.3.12 → 0.3.13
- `@shenlan/cli`: 0.4.60 → 0.4.61

---

## [0.4.60] — 2026-08-10

### Key changes

- Fixed a React Effect that could abort the agent loop when messages changed; a new `submitSeq` field now drives the effect.

### Package versions

- `@shenlan/cli`: 0.4.59 → 0.4.60

---

## [0.4.59] — 2026-08-10

### Key changes

- Debug logging enabled by default (`SHENLAN_DEBUG=0` to disable).

### Package versions

- `@shenlan/core`: 0.3.11 → 0.3.12
- `@shenlan/cli`: 0.4.58 → 0.4.59

---

## [0.4.58] — 2026-08-10

### Key changes

- Added the debug logger (`.shenlan/debug.log`) with API request/response and agent-loop instrumentation.

### Package versions

- `@shenlan/core`: 0.3.10 → 0.3.11
- `@shenlan/cli`: 0.4.57 → 0.4.58

---

## [0.4.57] — 2026-08-10

### Key changes

- Mandatory tool usage in the system prompt with `tool_choice: auto`, and tree-branch gutter lines for assistant messages.

### Package versions

- `@shenlan/core`: 0.3.9 → 0.3.10
- `@shenlan/cli`: 0.4.56 → 0.4.57

---

## [0.4.56] — 2026-08-10

### Key changes

- Production system prompt with a decision framework and tool reference.
- Added the `agent` tool for delegating subtasks, and the `/agents` command for concurrent execution.

### Package versions

- `@shenlan/core`: 0.3.8 → 0.3.9
- `@shenlan/cli`: 0.4.55 → 0.4.56

---

## [0.4.55] — 2026-08-10

### Key changes

- Streaming messages now indent consistently with completed messages.

### Package versions

- `@shenlan/cli`: 0.4.54 → 0.4.55

---

## [0.4.54] — 2026-08-10

### Key changes

- Fixed API 400 errors by cleaning up incomplete tool-call sequences before starting the agent loop.

### Package versions

- `@shenlan/cli`: 0.4.53 → 0.4.54

---

## [0.4.53] — 2026-08-10

### Key changes

- Assistant replies indent two columns, and a spinner shows during the thinking phase.

### Package versions

- `@shenlan/cli`: 0.4.52 → 0.4.53

---

## [0.4.52] — 2026-08-10

### Key changes

- Fixed message ordering and dropped-message bugs; tool status now shows live elapsed time.

### Package versions

- `@shenlan/cli`: 0.4.51 → 0.4.52

---

## [0.4.51] — 2026-08-09

### Key changes

- TUI layout fixes: fixed logo position, content-driven height, and memoized message rendering.
- Tool status shows query details and execution time; tool results render as full markdown.
- Removed the standalone `tavily_search` (unified into `web_search`), filtered reasoning content from search results, and capped search output at 2000 characters.

### Package versions

- `@shenlan/core`: 0.3.7 → 0.3.8
- `@shenlan/cli`: 0.4.33 → 0.4.51 (19 iterative releases)

---

## [0.4.0] — 2026-08-09

### Key changes

- Rewrote the interactive UI from scratch on Ink 7 (React): a status bar with logo, model, mode, and branch; a scrollable output viewport with frozen history plus a streaming area; native input handling with history and Tab completion; markdown rendering with code highlighting; tool status lines; and the first permission confirmation prompt.
- CLI versioning became independent via the `VERSION` constant.

### Package versions

- `@shenlan/cli`: 0.4.0
