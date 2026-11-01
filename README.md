# shenlan

An open-source agent workspace for your local terminal: bring your own keys (BYOK), with sessions, secrets, and memories stored on your machine by default. When the model is called, request content is sent to the model provider you configure. shenlan speaks the OpenAI-compatible protocol and ships with multi-model routing, cost guardrails, and an action safety net.

> 📖 中文文档：[README.zh-CN.md](README.zh-CN.md) · Full user manual (routing / permissions & safety / cost budgets / MCP·Skill·long tasks): [docs/user-guide.md](docs/user-guide.md)

## Run from source

```bash
git clone https://github.com/liam61-hub/shenlan.git
cd shenlan
npm ci
npm run build
node packages/cli/dist/index.js --version
node packages/cli/dist/index.js
```

Requires Node.js 22+. This source checkout is the supported distribution path; there is no public npm package yet. To update an existing checkout:

```bash
cd shenlan
git pull --ff-only origin master
npm ci
npm run build
node packages/cli/dist/index.js
```

Run the CLI from the repository root with `node packages/cli/dist/index.js`. `npm ci` installs the exact dependencies recorded in the lockfile, and rebuilding refreshes the CLI after each update.

## Contributing & reporting vulnerabilities

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Use [GitHub Issues](https://github.com/liam61-hub/shenlan/issues) for general questions and [SECURITY.md](SECURITY.md) for private vulnerability reports — do not disclose vulnerability details publicly.

## Quick start

### First use (3 minutes)

1. After installing, run `shenlan`. On first launch two config directories are created (with samples):
   - Global `~/.shenlan/`: `config.json` + `config.sample.json` + `README.md` + `env.example`
   - Project `.shenlan/`: the same, created the first time the CLI runs in a new directory
2. With no API key configured, the onboarding prompt appears automatically: `Enter` to configure → paste your key → `Enter` to save (connectivity is tested automatically) → quick tour (`/model` `/goal` `/security` `/keys` `/help`) → `Enter` to start. You can skip with `Esc` at any time and configure later via `/keys` or `shenlan --setup`.
3. Type a question to start a conversation; `/help` lists all commands; `Shift+Tab` switches permission modes.

### Configuring API keys (5 ways)

Precedence: real environment variables > project `.env` > global `~/.shenlan/.env` > project config > global config.

1. **Interactive UI**: the first-run onboarding, the `/keys` panel (masked display, paste support, automatic connectivity test after saving, `g`/`p` to switch global/project scope), or the `shenlan --setup` wizard.
2. **CLI commands**: `shenlan config` lists all config keys and environment variables (sensitive values masked); `shenlan config set/get/unset` edits configuration (equivalent to `/config` in the TUI):
   ```bash
   shenlan config set providerKeys.deepseek sk-xxx --global
   shenlan config set language zh-CN --global   # UI language (default en)
   shenlan config get model.model
   ```
3. **Edit config files**: write `providerKeys` in `~/.shenlan/config.json` (global) or `.shenlan/config.json` (project):
   ```json
   { "providerKeys": { "deepseek": "sk-xxx", "qwen": "sk-xxx" } }
   ```
   Field descriptions and full samples: `~/.shenlan/config.sample.json` and `~/.shenlan/README.md`.
4. **Environment variables**: the general rule is `<PROVIDER>_API_KEY`, with `SHENLAN_API_KEY` as a generic fallback. Environment variables take the highest precedence.
   ```bash
   export DEEPSEEK_API_KEY=sk-xxx
   # or the generic fallback
   export SHENLAN_API_KEY=sk-xxx
   ```
5. **`.env` files**: `KEY=VALUE` in project `cwd/.env` or global `~/.shenlan/.env`; real environment variables win, and the project `.env` overrides the global one. See `.shenlan/env.example`.
   ```bash
   DEEPSEEK_API_KEY=sk-xxx
   QWEN_API_KEY=sk-xxx
   ```

> ⚠️ `.env*` and `.shenlan/config.json` are blocked by the commit-time security check (`shenlan security` / pre-commit hook) — do not commit them to git.

### Verify

```bash
# Start the interactive REPL
shenlan

# Or a one-shot task
shenlan run "Read README.md and summarize the project's capabilities"
shenlan run --readonly "Read README.md and summarize the project's capabilities"   # readonly allows read/search tools only
```

## Daily use

```bash
# Interactive mode
shenlan                          # Enter the REPL for conversational interaction
shenlan --continue               # Continue the last session
shenlan --resume <id>            # Resume a specific session

# One-shot task mode
shenlan run "Fix the type errors in src/index.ts"
shenlan run --readonly "Inspect project status"

# First-time setup wizard
shenlan --setup

# View / edit configuration (same as /config; sensitive values masked)
shenlan config
shenlan config set agent.maxSteps 100

# Show version
shenlan --version
```

### REPL interaction examples

```
❯ Create a new skill for me
❯ Read package.json and list the dependencies
❯ /plan               Enter plan mode for read-only analysis first
❯ /keys               Configure / view API keys (masked)
❯ /config             Interactive config panel: ←/→ to switch, Enter to edit, effective immediately
❯ /goal Make all tests pass    Long-task goal mode (auto-wraps up on completion)
❯ /security           Commit-time security check (pre-commit hook)
❯ /cost               View token consumption
❯ /budget             Cost guardrail status (progress / waive / goal)
❯ /undo               Undo the last file modification
❯ Shift+Tab           Switch permission mode
```

### Configuring MCP servers

Edit `~/.shenlan/config.json` (global) or `.shenlan/config.json` (project) and add `mcpServers`:

**HTTP transport:**

```json
{
  "mcpServers": [{
    "name": "my-knowledge",
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": {
      "X-Api-Key": "env:MY_MCP_KEY"
    }
  }]
}
```

**stdio transport (launched as a local command):**

```json
{
  "mcpServers": [{
    "name": "my-knowledge-mcp",
    "transport": "stdio",
    "command": "my-knowledge-mcp",
    "args": [],
    "env": {
      "KNOWLEDGE_API_URL": "http://your-server:8100",
      "KNOWLEDGE_API_KEY": "your-api-key"
    }
  }]
}
```

Once started, MCP tools are registered automatically with names of the form `mcp__<server>__<tool>`. `env:VAR` references environment variables so keys never enter the config file.

### Using skills

Each skill is a directory containing `SKILL.md`:

```
.shenlan/skills/
├── my-skill/
│   └── SKILL.md          # skill definition (required)
└── another-skill/
    ├── SKILL.md
    └── references/        # reference files (optional)
```

**SKILL.md format:**

```markdown
---
name: my-skill
description: One-line summary the AI uses to decide when to trigger
---

# My Skill

Specific instructions telling the AI how to use this skill
```

**Triggering:**
- Explicit: type `$my-skill` to force invocation
- Automatic: the AI loads it when the description matches the task

**Locations:**

| Location | Scope |
|------|------|
| `.shenlan/skills/` | Current project, follows the repository |
| `~/.config/shenlan/skills/` | All projects on this machine |

shenlan ships with a built-in `$create-skill` skill — let the AI create new skills for you.

On first run the global `~/.shenlan/` and project `.shenlan/` directories are created automatically: `config.json` (effective) + `config.sample.json` (full sample) + `README.md` (field descriptions) + `env.example` (`.env` sample). Project config takes precedence over global config.

## Project structure

```
shenlan/
├── packages/core/   # @shenlan/core — kernel: LLM calls, tool system, session storage, config, MCP/skills/permissions; zero UI dependencies, independently unit-testable
├── packages/cli/    # @shenlan/cli — terminal: Ink 7 TUI, agent loop, slash commands, built-in skills
├── tsconfig.base.json
└── package.json     # npm workspaces
```

**Dependency direction**: `cli` → `core`; core has zero UI dependencies.

## Tech stack

- **Language**: TypeScript (strict mode, ES2022 + NodeNext)
- **Runtime**: Node.js 22+
- **Package management**: npm workspaces (monorepo)
- **Terminal**: Ink 7.1 (React 19) TUI with a bounded dynamic region and native terminal scrollback
- **LLM**: native fetch against OpenAI-compatible APIs (DeepSeek / Qwen / OpenAI / any OpenAI-compatible gateway)
- **Storage**: JSONL files for sessions

## Supported models

<!-- model-table:start -->
| Model | Tier | Context |
|------|------|--------|
| `deepseek-v4-flash` | Fast/economical | 1M tokens |
| `deepseek-v4-pro` | Strong reasoning | 1M tokens |
| `deepseek-v4-pro-0813` | Strong reasoning | 1M tokens |
| `qwen-turbo` | Fast/economical | 1M tokens |
| `qwen-plus` | Balanced | 128K tokens |
| `qwen-max` | Strongest reasoning | 128K tokens |
| `qwen3.7-flash` | Fast/economical | 1M tokens |
| `qwen3.7-plus` | Balanced | 128K tokens |
| `qwen3.7-max` | Strongest reasoning | 128K tokens |
| `qwen3.8-max` | Strongest reasoning | 128K tokens |
| `qwen3.8-2.4t-a95b` | Strongest reasoning | 128K tokens |
| `qwen-vl-max` | Strongest (vision) | 131K tokens |
| `gpt-5.4` | Strong reasoning (vision) | 400K tokens |
| `gpt-5.4-mini` | Fast/economical | 400K tokens |
<!-- model-table:end -->

Routing defaults to cost-first: models are picked dynamically by effective price (manual > auto-synced > built-in) — the cheapest for routine tasks, and the strongest for coding, reasoning, and long contexts. `/model auto|cost-first|quality-first|<model name>` switches and persists the policy (restored on restart). The model table is generated from the code catalog (`MODEL_CATALOG`) via `npm run docs:models`.

### Bring any OpenAI-compatible model (third-party gateways / Anthropic / Gemini / xAI / Mistral …)

shenlan speaks the OpenAI-compatible protocol end to end, so any compatible endpoint works:

1. Run `shenlan --setup` and choose `4 Custom OpenAI-compatible` (or select the Custom row in `/keys` and press Enter), then enter three fields:
   - **Base URL**: the compatible endpoint root (e.g. `https://openrouter.ai/api`; leave empty to auto-derive the official endpoint from the model name)
   - **API Key**: leave empty to cancel
   - **Model name**: free text (e.g. `gpt-5.4`, `claude-sonnet-4-5`, `deepseek-v4-pro-0813`, `llama-3.1-70b`); the provider is derived from the prefix (`gpt-*` → openai, `deepseek-v4-pro-0813` → bailian, etc.)
2. Or edit the config directly: `providerKeys` for keys, `providerBaseUrls` for endpoints (trailing `/v1` is normalized automatically).
3. Off-catalog models with a valid key are adopted as the default model (they don't join auto-routing); catalog models (table above) route cost-first automatically.

**Providers that work with a key alone (endpoints built in, no Base URL needed)**: deepseek, qwen, bailian, openai, plus doubao / zhipu / kimi:

| Model prefix | Provider | Environment variable | Built-in endpoint |
|---|---|---|---|
| `doubao-*` / `skylark-*` | doubao | `DOUBAO_API_KEY` | Volcano Ark `ark.cn-beijing.volces.com/api/v3` |
| `glm-*` | zhipu | `ZHIPU_API_KEY` | `open.bigmodel.cn/api/paas/v4` |
| `moonshot-*` | kimi | `KIMI_API_KEY` | Moonshot CN `api.moonshot.cn` |

These three are not in the catalog (prices/windows not verified) and follow the "off-catalog model + valid key" path, with costs accounted via same-tier fallback estimates. Overseas account keys are not interchangeable with CN ones — override the endpoint via `providerBaseUrls`, e.g. `{"kimi": "https://api.moonshot.ai"}`.

Example (Claude via Anthropic's official OpenAI-compatible endpoint, bailian-hosted snapshot):

```json
{
  "providerKeys": { "claude": "sk-ant-xxx", "bailian": "sk-bailian-key" },
  "providerBaseUrls": { "claude": "https://api.anthropic.com" }
}
```

Equivalent environment variables: `export ANTHROPIC_BASE_URL=...`, `export BAILIAN_API_KEY=sk-xxx` (general rule `<PROVIDER>_API_KEY`; openai accepts `OPENAI_API_KEY` and the legacy `GPT_API_KEY`).

## Configuration

Precedence (high to low): real environment variables > project `.env` > global `~/.shenlan/.env` > project `.shenlan/config.json` > global `~/.shenlan/config.json`

On first run the `~/.shenlan/` and project `.shenlan/` directories are generated: `config.json` (effective) + `config.sample.json` (full field samples) + `README.md` (field descriptions) + `env.example` (`.env` sample). Missing samples are rewritten on the next launch; existing files are never overwritten.

### Environment variables

| Variable | Description |
|------|------|
| `DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `OPENAI_API_KEY` / `BAILIAN_API_KEY` | API keys per provider (general rule `<PROVIDER>_API_KEY`; can also be written to `providerKeys` in config; environment variables win; `OPENAI_API_KEY` is compatible with the legacy `GPT_API_KEY`) |
| `SHENLAN_API_KEY` | Generic fallback key |
| `SHENLAN_BASE_URL` | API endpoint override (by default auto-derived per model provider: deepseek → `api.deepseek.com`, qwen → dashscope compatible-mode) |
| `SHENLAN_MODEL` | Model name override |
| `TAVILY_API_KEY` | Tavily search key (fallback for models without native web search) |

### `.env` files

- Location: project `cwd/.env` (preferred) or global `~/.shenlan/.env` (fallback).
- Format: `KEY=VALUE` per line, with `#` comments, `export ` prefix, and quoting supported; real environment variables (shell export) take precedence over `.env`.
- Sample: `.shenlan/env.example` (auto-generated on first run in a new directory).

```bash
# Project root .env
DEEPSEEK_API_KEY=sk-xxx
QWEN_API_KEY=sk-xxx
```

### Config files

Config lives in `~/.shenlan/config.json` (global) or `.shenlan/config.json` (project), for example:

```json
{
  "model": {
    "baseUrl": "",
    "apiKey": "",
    "model": "deepseek-v4-flash",
    "maxTokens": 8192
  },
  "providerKeys": {
    "deepseek": "sk-xxx",
    "qwen": "sk-xxx"
  },
  "permissions": {
    "mode": "default",
    "allow": ["read", "search"],
    "deny": []
  },
  "skills": [],
  "mcpServers": []
}
```

With `model.baseUrl` empty, the endpoint is auto-derived per model provider. API key precedence: environment variable `<PROVIDER>_API_KEY` > `providerKeys` > `model.apiKey`. The `--setup` wizard can configure DeepSeek and/or qwen at once (keys written to `providerKeys`, default model selection, per-provider connectivity tests).

Full field samples: `~/.shenlan/config.sample.json` (global) and `.shenlan/config.sample.json` (project); field descriptions live in each directory's `README.md`. Key-related files are created with 0600 permissions and the global directory with 0700 — readable only by the current user.

### Permission modes

| Mode | Reads | Writes | Shell |
|------|--------|--------|-------|
| `default` | allowed | confirm | confirm |
| `acceptEdits` | allowed | allowed | confirm |
| `bypassPermissions` | allowed | allowed | allowed |
| `plan` | read-only planning | denied | denied |

> Plan mode has the highest priority: write/edit/shell are always denied (even after bypass); other tools are allowed.

## Built-in tools

| Tool | Description |
|------|------|
| `read` | Read files, with line ranges |
| `write` | Write files (automatic snapshots, undoable via /undo) |
| `edit` | Precise string-replacement editing (automatic snapshots) |
| `shell` | Run shell commands (high-risk interception; timeouts move to background instead of killing) |
| `shell_status` / `shell_kill` | Inspect / terminate background shell commands (created after shell timeouts) |
| `search` | Regex content search (ripgrep) |
| `glob` | Filename pattern matching (supports `**` recursion) |
| `web_search` | Web search (native for DeepSeek / qwen, Tavily for other models; native failures don't silently downgrade) |
| `web_fetch` | Fetch web page content |
| `pitfall_search` | Search pitfall records by trigger / symptom |
| `ref_outline` / `ref_retrieve` | View external reference directories / retrieve full text |
| `restore` | Restore files from the trash (with /trash) |
| `todo_write` / `update_plan` | Task todos and execution plans (minimal dynamic-region UI) |
| `agent` | Spawn sub-agents to execute subtasks (serial in the main loop; `/agents` for parallel orchestration) |
| `memory_save` | Save cross-session memories (`/memory` to view; hidden from the model when `memory.autoSave=false`) |
| MCP dynamic tools | Auto-registered from configured MCP servers |

## Slash commands

| Command | Description |
|------|------|
| `/help` `/h` | Show help |
| `/model [name]` | View or switch models |
| `/keys` | Configure / view API keys (masked, global/project, paste support) |
| `/security` | Commit-time security check (pre-commit hook status / install / uninstall / manual scan) |
| `/goal [goal]` | Long-task goal mode (`/goal <verifiable goal>`, `pause`/`resume`/`clear`) |
| `/mcp` | Manage MCP servers |
| `/skills` | List installed skills |
| `/memory` | View local memories |
| `/permissions` | View permission modes |
| `/sessions` | List sessions |
| `/plan [save]` | Enter plan mode (`/plan off` exits with confirmation; `/plan save [title]` persists the plan) |
| `/agents` `/a` | Decompose tasks into sub-agents |
| `/cost` | View current session cost |
| `/budget` | Cost guardrail status (progress / waive / goal) |
| `/prices` | View the price table (`/prices check` triggers an official sync) |
| `/context` | Context composition and compaction threshold |
| `/compact` | Compact context manually |
| `/undo` | Undo the last write/edit |
| `/pitfall` | View project pitfall records |
| `/trash` | Trash management |
| `/temp` `/audit` | View snapshot count / session and model audit |
| `/cleanup` | Clean up snapshot files |
| `/clear` | Clear the session (no screen clearing, scrollback preserved, confirmation hint right above the input) |
| `/stop` | Stop the current task |
| `/quit` `/exit` `/q` | Quit |

## Session storage

Sessions are stored as JSONL files in `~/.local/share/shenlan/sessions/` (macOS/Linux; Windows: `%LOCALAPPDATA%\shenlan\sessions`), one message event per line.

## Development

```bash
# Compile
npm run build

# Run all unit tests (vitest)
npm test

# Watch-mode incremental compile
npm run dev

# PTY end-to-end tests (macOS/Linux, requires python3, see packages/cli/e2e/README.md)
npm run test:e2e

# Clean build artifacts
npm run clean
```

## Design principles

- **Zero UI dependencies in the kernel**: all decision logic lives in core; the CLI only renders and reads input
- **Testability first**: every module is independent and unit-testable
- **Configuration-driven**: model names, permission rules, and skill directories are all configurable

## Version

Current version: **v0.4.90** — version history per [CHANGELOG.md](./CHANGELOG.md)

## License

MIT
