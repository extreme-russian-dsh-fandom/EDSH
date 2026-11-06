# ECC for DeepSeek Harness

This directory is the first-class [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
adapter for ECC. It is a native Cordis bundle, not a compatibility shim: ECC
skills, slash commands, hook enforcement, and specialist agents run on DSH's own
registries and event model.

Canonical ECC assets stay in `skills/`, `commands/`, `agents/`, `hooks/`, and
`rules/`. This adapter contains only the DSH wiring.

## What you get

| Surface | DSH integration | Count |
|---|---|---|
| Skills | Global `skill` provider reading `skills/<name>/SKILL.md` | 313 default (314 canonical) |
| Slash commands | `ctx.commands` registrations that steer the expanded prompt | 98 |
| Agents | One `ecc_agent` delegation tool backed by the DSH subagent service | 71 |
| Hooks | Native bridge from ECC hook events to DSH agent/tool events | 27 parsed (26 supported) |
| Rules | Installed with the rest of the runtime for skills and commands | `rules/` |

`/ecc-doctor` reports the live counts and every skipped or unsupported surface.

## Requirements

- DeepSeek Harness `0.2.1-rc.5` or newer. The adapter uses the public
  `commands`, `skills`, `tools`, `subagents`, and agent event surfaces.
- Node.js 20 or newer.
- A checkout of this repository.

The adapter is verified against DSH `0.2.1-rc.5` on the Desktop profile. The
CLI/web composition uses the same public services; re-run `/ecc-doctor` after
upgrading DSH. A packed or published install must set `eccRoot` explicitly;
local directory installation links the checkout, so the default bundle parent
is correct.

## Install

```bash
# 1. Copy the adapter, skills, commands, agents, hooks, and hook runtime.
./install.sh --profile dsh --target dsh --enable-hooks

# 2. Activate the bundle in the profile that should load it.
node scripts/dsh/activate.js --profile desktop
```

On Windows:

```powershell
./install.ps1 --profile dsh --target dsh --enable-hooks
node scripts/dsh/activate.js --profile desktop
```

Restart DeepSeek Harness, or start a new session in a running app, then run
`/ecc-doctor` in that session.

`--profile dsh` installs the complete engineering catalog: every command, agent,
hook, and rule, plus 313 of the 314 canonical skills. The experimental Nasiko
control-plane skill stays opt-in; add it with
`--modules nasiko-control-plane`. Use `--profile core` for a smaller
rules/commands/hooks/agents install, or `--without` components as usual. The
installer writes:

```text
~/.dsh/ecc/
  bundle/       # the Cordis bundle (this directory, linked or copied)
  skills/       # ECC skills read by the bundle's skill provider
  commands/     # ECC command Markdown
  agents/       # ECC agent Markdown
  hooks/        # hooks.json
  scripts/      # hook runtime
  rules/        # ECC rule packs
```

`activate.js` appends one managed `insert` block to
`~/.dsh/profiles/<name>/cordis.patch.yml`. The block points at the bundle by a
path relative to the profile, so no package-manager step is required. Re-run
the command after each install to refresh the block; `--remove` restores the
patch file.

If you prefer DSH's own lifecycle, install the generated bundle directly:

```text
plugin_manager action=install_bundle target=/absolute/path/to/.dsh/ecc/bundle
```

The bundle's patch declares host-plane rows, so ECC works in every agent preset
without changing the preset roster.

## Verify

Inside a DSH session:

```text
/ecc-doctor
```

Outside DSH:

```bash
node tests/dsh/catalog.test.js
node tests/dsh/hook-bridge.test.js
node tests/dsh/plugin-wiring.test.js
node tests/dsh/install-target.test.js
node tests/dsh/activation.test.js
node scripts/harness-adapter-compliance.js --check
```

A healthy result shows 313 installed skills (314 canonical), 98 commands (plus
`/ecc-plan` and `/ecc-doctor`), 71 agents, and 27 parsed hook commands (26
supported). `PreCompact` is expected to be listed as unsupported.

You can also confirm the rows are live with the Host inspection tools:

```text
cordis_inspect_query platform=host provider=Config method=listConfigs name=@ecc/dsh
```

## Slash commands

ECC commands are prompt templates. DSH commands run directly against the agent,
so the adapter expands `$ARGUMENTS`, `$1`-`$9`, and any unclaimed input, then
steers the result to the model. The command result itself is not a model
message.

DSH already owns `/plan` (plan mode). ECC registers the same command as
`/ecc-plan`; every other ECC command keeps its name. `/ecc-doctor` is built in.

## Specialist agents

`ecc_agent` takes a specialist name and a task. The child joins the caller's
current preset, so it keeps the parent's tools, and receives the specialist's
role instructions as its opening task. The parent gets the normal subagent
completion notice.

```text
ecc_agent agent=code-reviewer task="Review the working tree and report only blocking issues."
```

The tool description contains the full agent directory. If the subagent service
or the `spawn` provider is absent, the tool returns an actionable error instead
of silently degrading.

## Hook bridge

The bridge reads ECC's canonical `hooks/hooks.json` and keeps every command,
timeout, async flag, matcher, and hook-profile flag. It maps DSH events:

| ECC event | DSH event | Behavior |
|---|---|---|
| `SessionStart` | `agent/created` | Context is injected before the first request |
| `UserPromptSubmit` | `agent/pre-step` | Additional context is injected for the step |
| `PreToolUse` | `tools/pre-execute` | `deny` and `ask` become DSH decisions |
| `PostToolUse` | `tools/post-execute` | `block` becomes DSH feedback |
| `PostToolUseFailure` | `tools/post-execute` on error | Same post-hook contract |
| `Stop` | `agent/turn-stopping` | A blocking reason steers the agent to continue |
| `SessionEnd` | `agent/disposed` | Cleanup hooks run without blocking disposal |
| `SubagentStart` | `subagent/start` | Observation hooks run in the background |
| `SubagentStop` | `subagent/end` | Observation hooks run in the background |
| `PreCompact` | no public DSH event | Reported by `/ecc-doctor`; never silently claimed |

Commands beginning with `node` are spawned directly with the Host's Node binary,
so quoting, spaces in the checkout path, and Windows do not depend on a shell.
Third-party shell hooks fall back to the platform shell. Hook input is bounded
to 1 MiB; an oversized tool response is replaced with a marker instead of
sending invalid JSON.

Stop hooks that declare a timeout above `stopBlockingTimeoutSeconds` (default
30) run in the background. This keeps a formatting or type-check hook from
holding a turn open while preserving the quick Stop hooks that intentionally
steer the agent.

## Configuration

Each row accepts `enabled`, `eccRoot`, and `logWarnings`; the defaults resolve
`eccRoot` to the bundle's parent.

| Row | Fields |
|---|---|
| `ecc-skills` | `skillsDir`, `cacheTtlMs` |
| `ecc-commands` | `commandsDir`, `includeDoctor`, `includeAliases`, `descriptionMaxLength` |
| `ecc-agents` | `agentsDir`, `provider`, `descriptionMaxLength` |
| `ecc-hooks` | `hooksPath`, `profile`, `timeoutSeconds`, `maxTimeoutSeconds`, `asyncHooks`, `injectContext`, `maxStopBlocks`, `stopBlockingTimeoutSeconds`, `maxInputBytes`, `maxOutputBytes` |

To disable one surface, set `enabled: false` on its row in the profile patch.

## Update and uninstall

```bash
# Update
git pull
./install.sh --profile dsh --target dsh --enable-hooks
node scripts/dsh/activate.js --profile desktop

# Uninstall
node scripts/dsh/activate.js --profile desktop --remove
rm -rf ~/.dsh/ecc
```

Skills, commands, agents, and hooks are copied under `~/.dsh/ecc`; the adapter
does not claim or modify `~/.dsh/skills`, any user `AGENTS.md`, or unrelated
profile rows. An install-state file records managed copies for repair and
rollback.

## Security

Hooks execute local Node processes from this checkout with the Host's
permissions. Install only from a reviewed checkout, keep the checkout outside
world-writable directories, and review `hooks/hooks.json` before enabling the
runtime. The adapter never installs network MCP servers, never reads
credentials, and never sends repository content anywhere.

## Layout

```text
.dsh/
  package.json          # @ecc/dsh bundle manifest
  cordis.patch.yml      # Host rows
  skills.js             # global skill provider
  commands.js           # slash commands + /ecc-doctor
  hooks.js              # event bridge
  agents.js             # ecc_agent tool
  lib/                  # catalogs, protocol, runner, doctor
  locale/en.json        # plugin-manager display metadata
  icon.svg              # bundle icon
```
