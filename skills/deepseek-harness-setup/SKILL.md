---
name: deepseek-harness-setup
description: "Install, verify, and operate ECC on the DeepSeek Harness (DSH): the native Cordis bundle in .dsh/, the install.sh --target dsh target, profile activation, 314 skills, 98 slash commands, 71 specialists through ecc_agent, and the native hook bridge. Use when setting up ECC on DeepSeek Harness, activating or debugging the bundle, or explaining which Claude Code surfaces DSH cannot reproduce."
metadata:
  origin: community
---

# DeepSeek Harness Setup

ECC runs on DSH as a native Cordis bundle. Canonical assets stay in `skills/`,
`commands/`, `agents/`, `hooks/`, and `rules/`; `.dsh/` contains only the DSH
wiring. Full guide: `docs/DEEPSEEK-HARNESS-GUIDE.md`.

## When to Activate

- Installing or updating ECC on a DSH Desktop or CLI/web profile.
- Verifying that skills, commands, agents, or hooks loaded.
- Debugging a profile whose patch layer did not mount the ECC rows.
- Explaining DSH-specific differences before promising Claude Code parity.

## Install and Activate

```bash
./install.sh --profile dsh --target dsh --enable-hooks
node scripts/dsh/activate.js --profile desktop
```

The installer writes the runtime under `~/.dsh/ecc/` and leaves user skill roots
alone. `activate.js` appends one managed `insert` block to
`~/.dsh/profiles/<name>/cordis.patch.yml` with relative paths to
`ecc/bundle/skills.js`, `commands.js`, `hooks.js`, and `agents.js`. The block is
idempotent; `--remove` restores the patch exactly.

Alternative for the DSH plugin lifecycle: install the generated bundle directory
with `plugin_manager action=install_bundle target=/absolute/path/to/.dsh/ecc/bundle`.
Use one activation path, not both.

## What Loads

| Surface | Mechanism | Expected |
|---|---|---|
| Skills | global `skills` provider | 313 default (314 canonical) |
| Commands | `commands` registrations | 98 + `/ecc-doctor` |
| Agents | `ecc_agent` tool | 71 |
| Hooks | agent/tool event listeners | 27 parsed (26 supported) |

The experimental Nasiko control-plane skill is opt-in. Add it with
`--modules nasiko-control-plane`; `/ecc-doctor` reports the installed count.

`/ecc-doctor` reports the live counts, aliases, skipped files, and unsupported
events. `/plan` is owned by DSH plan mode, so ECC's command is `/ecc-plan`.

## Verify

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
```

Host inspection:

```text
cordis_inspect_query platform=host provider=Config method=listConfigs name=@ecc/dsh
```

The four rows `ecc-skills`, `ecc-commands`, `ecc-hooks`, and `ecc-agents` must
exist. A missing row means the profile patch was not applied or the relative
bundle path is wrong.

## Debugging

- **No commands in the slash menu:** confirm the profile patch block points at an
  existing `~/.dsh/ecc/bundle/commands.js` and restart DSH. The Loader imports
  relative `name` values beside the patch file.
- **Skills missing but commands work:** inspect `~/.dsh/ecc/skills`; the skill
  provider resolves `eccRoot` as the parent of the bundle directory. A packed
  install must set `eccRoot` explicitly.
- **A hook is skipped:** `/ecc-doctor` lists unsupported events. `PreCompact` has
  no DSH event and is intentionally skipped.
- **Duplicate hook decisions:** stop hooks with timeouts above
  `stopBlockingTimeoutSeconds` run in the background; lower that value only if a
  quick Stop hook needs to block more often.
- **`/plan` behavior differs:** DSH plan mode owns that name. Use `/ecc-plan` for
  the ECC planning command, or use DSH plan mode directly.

## Updating and Removing

```bash
git pull
./install.sh --profile dsh --target dsh --enable-hooks
node scripts/dsh/activate.js --profile desktop

node scripts/dsh/activate.js --profile desktop --remove
rm -rf ~/.dsh/ecc
```

The activation block is replaced in place; unrelated profile rows survive.

## Anti-Patterns

- Do not install into `~/.dsh/skills` by hand: the bundle owns a global skill provider, and duplicate copies shadow each other.
- Do not mount the bundle through both `activate.js` and `plugin_manager`: pick one lifecycle and keep it.
- Do not promise PreCompact hook parity or Claude slash-command history semantics on DSH.
- Do not assume ECC's `tools:` or `model:` lines restrict a delegated child; DSH inherits the caller preset.

## Limits

| Surface | DSH status |
|---|---|
| Skills | Native provider over `SKILL.md`; no copies into `~/.dsh/skills` |
| Commands | Native, as steered prompt expansions (not history rewrites) |
| Agents | One `ecc_agent` tool; child inherits the caller's preset |
| Hooks | 27 parsed, 26 supported on 7 events; PreCompact unsupported |
| Rules | Installed assets; no global `AGENTS.md` rewrite |
| Model hints | ECC `tools:`/`model:` lines are guidance, not DSH enforcement |

Install only from a reviewed checkout. Hooks execute local Node processes with
the Host's permissions.
