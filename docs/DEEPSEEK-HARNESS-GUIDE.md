# DeepSeek Harness Guide

ECC runs on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) as a native Cordis bundle. The adapter is in [`.dsh/`](../.dsh/README.md);
this guide is the operator-facing setup and reference page.

The integration is deliberately thin: canonical ECC skills, commands, agents,
hooks, and rules stay in their normal directories. DSH gets one Host-plane
bundle that registers four surfaces on the harness's own services.

## Requirements

- DeepSeek Harness `0.2.1-rc.5` or newer (verified against `0.2.1-rc.5`).
- Node.js 20 or newer.
- An ECC checkout.

The Desktop profile is verified against `0.2.1-rc.5`; the CLI/web composition
uses the same public services and should be rechecked with `/ecc-doctor` after
an upgrade. The adapter does not need a `dsh` binary on `PATH`; the installer
writes files and the profile activation script edits the profile patch layer.

## Install

```bash
git clone https://github.com/extreme-russian-dsh-fandom/EDSH.git
cd EDSH

# 1. Install the full ECC catalog into the DSH home.
./install.sh --profile dsh --target dsh --enable-hooks

# 2. Activate the bundle in the profile that should load it.
node scripts/dsh/activate.js --profile desktop
```

Windows PowerShell:

```powershell
./install.ps1 --profile dsh --target dsh --enable-hooks
node scripts/dsh/activate.js --profile desktop
```

Use `--profile core` for a smaller install, or `--modules` for an explicit set.
The installer copies assets under `~/.dsh/ecc/`:

```text
~/.dsh/ecc/
  bundle/       # .dsh Cordis bundle
  skills/       # 313 skills by default (314 canonical; Nasiko is opt-in)
  commands/     # 98 commands
  agents/       # 71 agents
  hooks/        # hooks.json
  scripts/      # hook runtime
  rules/        # ECC rule packs
  mcp-configs/  # reference configs
  install-state.json
```

`activate.js` appends a managed block to
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: ecc-skills
      name: "../../ecc/bundle/skills.js"
    - id: ecc-commands
      name: "../../ecc/bundle/commands.js"
    - id: ecc-hooks
      name: "../../ecc/bundle/hooks.js"
    - id: ecc-agents
      name: "../../ecc/bundle/agents.js"
```

Relative `name` values are anchored beside the profile patch file by the DSH
Loader, so no package-manager step is required. The block is idempotent and
`--remove` restores the user's patch layer.

### Alternative: DSH plugin lifecycle

A local bundle directory is linked rather than copied by
`plugin_manager install_bundle`. Install the generated bundle directly if you
prefer the DSH lifecycle:

```text
plugin_manager action=install_bundle target=/absolute/path/to/.dsh/ecc/bundle
```

Both paths end with the same four Host rows. Do not stack them.

## Surfaces

| Surface | DSH mechanism | What ECC supplies |
|---|---|---|
| Skills | Global `ctx.skills` provider | 313 default skills (314 canonical) |
| Commands | `ctx.commands.register` | 98 prompt-template commands plus `/ecc-doctor` |
| Agents | `ctx.tools.register` + `ctx.subagents` | One `ecc_agent` tool over 71 specialists |
| Hooks | Agent and tool event listeners | 27 parsed (26 supported) |
| Rules | Runtime assets | `rules/common/` and language rule packs for skills and commands |

Every row is Host-plane, so ECC is available in every agent preset. The adapter
does not add or replace a preset.

### Skills

`ecc-skills` scans `<eccRoot>/skills/*/SKILL.md` and registers an `ecc` provider
on the global skills layer. Catalog discovery reads frontmatter only; a load
re-reads the current body, so editing a skill needs no restart. Name conflicts
with user roots resolve by the normal DSH priority chain; ECC never copies into
`~/.dsh/skills`.

The `dsh` install profile includes 313 of the 314 canonical skills. The
experimental Nasiko control-plane skill remains opt-in and can be added with
`--modules nasiko-control-plane`; `/ecc-doctor` reports the installed count.

### Commands

An ECC command is a prompt template, while a DSH command is a direct human
action. The adapter:

1. reads the command frontmatter and body;
2. expands `$ARGUMENTS`, `${ARGUMENTS}`, `$1`-`$9`, and `${1}`-`${9}`;
3. appends the user's input as a `## User Input` section when the body has no
   placeholder;
4. steers the expanded prompt to the receiving agent and returns a short result.

The command result stays outside model history. `/plan` is already owned by DSH
plan mode, so ECC's command is registered as `/ecc-plan`; every other command
keeps its name. `/ecc-doctor` is built in.

### Agents

`ecc_agent` takes `agent`, `task`, and an optional `cwd`. The adapter reads
`agents/*.md`, composes the specialist's role prompt and the task, and starts a
context-free child through the DSH subagent service using the caller's current
preset. The child therefore keeps the parent's tools; the role prompt and the
delegated task define the specialist work. The parent receives the standard
completion notice.

The tool description lists all 71 specialists within a bounded character budget,
and the `agent` parameter is an enum of exact names. Unknown names fail before
any child is created.

### Hooks

The bridge keeps `hooks/hooks.json` as the source of truth. Commands, matchers,
timeouts, async flags, `ECC_HOOK_PROFILE`, and `ECC_DISABLED_HOOKS` are preserved.

| ECC event | DSH event | Translation |
|---|---|---|
| `SessionStart` | `agent/created` | Hook context is injected before the first request |
| `UserPromptSubmit` | `agent/pre-step` | Additional context is injected for the step |
| `PreToolUse` | `tools/pre-execute` | `deny` → deny; `ask` → ask; context → inject |
| `PostToolUse` | `tools/post-execute` | `block` → feedback; context → inject |
| `PostToolUseFailure` | `tools/post-execute` (error result) | Same post-hook contract |
| `Stop` | `agent/turn-stopping` | A blocking reason steers another step |
| `SessionEnd` | `agent/disposed` | Cleanup runs without blocking disposal |
| `SubagentStart` | `subagent/start` | Observation runs in the background |
| `SubagentStop` | `subagent/end` | Observation runs in the background |
| `PreCompact` | no public DSH event | Reported as unsupported by `/ecc-doctor` |

Hook input is the documented Claude Code JSON, built from DSH values:
`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_response`, `prompt`, `source`, and `agent_id`. Tool names and arguments are
mapped to the Claude names ECC hooks inspect (`bash`/`pwsh` → `Bash`/`PowerShell`,
`write` → `Write`, `edit` → `Edit`, and so on).

Execution:

- A command that starts with `node` is spawned directly with the Host's Node
  binary. No shell quoting is involved, including for checkout paths with
  spaces or Windows paths.
- Other commands fall back to the platform shell.
- Synchronous hooks are awaited; `async: true` hooks are fire-and-forget.
- Stop hooks with a timeout above `stopBlockingTimeoutSeconds` (default 30) run
  in the background, so a long formatter or type-check cannot freeze a turn.
- Hook input is capped at 1 MiB. An oversized tool response is replaced by a
  valid truncation marker; the bridge never sends malformed JSON.
- Hook failures are logged and fail open, except an explicit `deny`/`block`
  result or exit code 2.

### Rules

Rules are installed with the rest of the runtime for skills and commands. The
adapter does not rewrite a user's global `AGENTS.md`; project instructions keep
their normal DSH precedence.

## Verify

Inside a DSH session:

```text
/ecc-doctor
```

The report shows the ECC root, skill/command/agent counts, hook coverage, names
that were aliased because the harness owns them, and every unsupported event.

Outside DSH:

```bash
node tests/dsh/catalog.test.js
node tests/dsh/hook-bridge.test.js
node tests/dsh/plugin-wiring.test.js
node tests/dsh/install-target.test.js
node tests/dsh/activation.test.js
npm run harness:adapters -- --check
```

Optional Host-side inspection:

```text
cordis_inspect_query platform=host provider=Config method=listConfigs name=@ecc/dsh
```

The four rows should appear as `ecc-skills`, `ecc-commands`, `ecc-hooks`, and
`ecc-agents`.

## Updating

```bash
git pull
./install.sh --profile dsh --target dsh --enable-hooks
node scripts/dsh/activate.js --profile desktop
```

The activation block is replaced in place; unrelated profile rows are preserved.
Skills, commands, agents, and hooks come from the refreshed install.

## Uninstall

```bash
node scripts/dsh/activate.js --profile desktop --remove
rm -rf ~/.dsh/ecc
```

`--remove` deletes only the managed block. The installer's state file under
`~/.dsh/ecc` records managed copies; removing that directory removes the
adapter's files and the bundle.

## Limits

- **PreCompact has no DSH counterpart.** The PreCompact hook is reported, never
  silently claimed.
- **Commands are prompt expansions.** DSH command results cannot rewrite model
  history; the adapter steers the prompt as the next user-role input.
- **Agent tools follow the parent.** A delegated ECC agent inherits the caller's
  preset, so its available tools may be broader or narrower than the agent's
  Claude Code `tools:` line. The role prompt states the intended tools and asks
  the child to report a capability gap.
- **Model names are metadata.** ECC's `model: opus`/`sonnet` hints are not
  translated to DeepSeek routes; DSH owns model selection.
- **Packed installs must set `eccRoot`.** A local directory install is linked and
  resolves the parent bundle directory automatically. A packed package must set
  `eccRoot` on each row to the installed ECC runtime root.

## Legacy bridge

DSH `0.2.0-rc.1` exposed `@deepseek-ai/dsh-hooks-claude-code`, a first-party
bridge for Claude Code command hooks. [PR #3309](https://github.com/affaan-m/ECC/pull/3309)
introduced that manual path; it was merged through PR #3495 and is the ancestor
of today's adapter. The package is not part of the `0.2.1` Desktop runtime, so
current installs use the native bridge in `.dsh/hooks.js`.

For an older 0.2.0 CLI installation that still ships the bridge:

```bash
node scripts/dsh/generate-hooks-config.js \
  --ecc-root /path/to/ECC \
  --out ~/.dsh/ecc/hooks-dsh.json
```

Then add one bare `insert` row to
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: ecc-hooks-claude-code
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: /absolute/path/to/hooks-dsh.json
```

The legacy path covers only the events the 0.2.0 bridge supported (the generator
prints what it skipped), exposes skills only through linked roots, and provides
neither native commands nor agent dispatch nor an installer target. Do not use
it on `0.2.1` or newer: the package is absent, and the native bundle provides 26
supported hooks plus the commands, agents, and skills.

## Security

The hook bridge executes local Node processes from the ECC checkout with the
Host's permissions. Install only from a reviewed checkout, keep the checkout
outside world-writable directories, and read `hooks/hooks.json` before enabling
the runtime. ECC does not install network MCP servers, read credentials, or
send repository content anywhere.
