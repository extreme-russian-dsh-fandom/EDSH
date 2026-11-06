# DSH Native Adapter Decision

Status: accepted
Date: 2026-11-06
Owners: ECC maintainers
Supersedes: the manual bridge path from [PR #3309](https://github.com/affaan-m/ECC/pull/3309), merged through PR #3495

## Context

ECC's first DeepSeek Harness (DSH) surface was a manual setup: link skill
directories into a DSH skill root, generate a Claude Code hooks document, and
mount the first-party `@deepseek-ai/dsh-hooks-claude-code` bridge in a profile
patch. That work was small, careful, and correct for DSH `0.2.0-rc.1`.

DSH `0.2.1-rc.5` changes the contract:

- The `hooks-claude-code` bridge is no longer part of the Desktop runtime.
- The harness exposes native `commands`, `skills`, `tools`, `subagents`, and
  agent/tool events.
- A local Cordis bundle can register Host-plane rows without a package-manager
  install; relative module paths in a profile patch are anchored beside the
  patch file.

The manual path therefore cannot satisfy the current harness. A second
generation adapter must use DSH's own registries.

## Decision

Ship `.dsh/` as a native Cordis bundle with four Host rows:

| Row | Surface | Implementation |
|---|---|---|
| `ecc-skills` | Skills | A global `ctx.skills` provider over `skills/*/SKILL.md` |
| `ecc-commands` | Commands | `ctx.commands` registrations that steer expanded prompts |
| `ecc-hooks` | Hooks | A bridge from ECC hook events to DSH agent/tool events |
| `ecc-agents` | Agents | One `ecc_agent` tool over `ctx.subagents` |

Add a `dsh` install target (`dsh-home`) and a profile activation helper so the
runtime is installed, tracked, repaired, and removed like any other ECC
adapter.

## Evaluation of PR #3309

### Strengths

- Correctly identified DSH's native `SKILL.md` compatibility and documented the
  root priority order.
- Recorded loader behavior that is easy to get wrong: a plain top-level entry
  is dropped; `insert` under a non-group id is rejected; first-party packages
  need no profile `package.json` entry.
- The generator received real fixes during review: shell-quoted environment
  prefixes (CWE-78), matcher preservation for `^mcp__` and regex tokens, and
  argument validation. Those properties remain in the legacy generator and are
  covered by tests.
- Small, focused, and testable; it did not pretend commands or agents were
  available on `0.2.0`.

### Limits

- Depends on a first-party bridge that `0.2.1` does not ship.
- Manual per-skill symlinks do not create the destination, do not iterate the
  catalog, and the placeholder command fails as written.
- Initial verification trusted a successful compose exit status; dropped rows
  are reported on stderr only.
- Skill, command, and agent counts and the DSH repository URL drifted from the
  repository catalog.
- No installer target, no profile activation automation, no native commands, no
  agent dispatch, and only the events the old bridge supported.
- Tests covered the converter, not a mounted harness composition.

The useful security and loader details were kept; the setup model was replaced.
PR #3309 remains the documented legacy path for `0.2.0` CLI installations.

## Alternatives considered

- **Keep linking skills into `~/.dsh/skills`.** Rejected: duplicates user roots,
  needs a link farm, and cannot provide commands, agents, or current hooks.
- **Wrap the old bridge.** Rejected: the package is absent from `0.2.1`.
- **Use one preset per ECC agent.** Rejected: 71 roster entries clutter the
  preset picker; `ecc_agent` plus the caller's preset keeps one entry point and
  preserves the caller's tools.
- **Mount a preset instead of Host rows.** Rejected: ECC should be available in
  every preset, and commands/skills are registries, not per-agent tools.

## Consequences

- ECC works in every DSH preset, including user-created ones.
- `/plan` is owned by DSH plan mode; ECC's command is `/ecc-plan`.
- Commands steer prompt expansions; they cannot rewrite model history.
- Delegated agents inherit the caller preset; ECC `tools:` lines are guidance.
- `PreCompact` has no DSH event and is reported by `/ecc-doctor`.
- The `dsh` profile ships 313 of 314 canonical skills; the experimental Nasiko
  control-plane skill remains opt-in.

## Verification

```bash
node tests/dsh/catalog.test.js
node tests/dsh/hook-bridge.test.js
node tests/dsh/plugin-wiring.test.js
node tests/dsh/install-target.test.js
node tests/dsh/activation.test.js
node scripts/harness-adapter-compliance.js --check
```

A disposable `DSH_HOME` was installed end to end, the profile block was applied
and removed, and the installed bundle was loaded with a fake Cordis context:
98 command files registered (plus `/ecc-doctor`), 71 agents available, 27 hook
commands parsed, and the skill provider read the installed catalog (313 in the
default profile, 314 in a source checkout). Live DSH model/session execution
was not run in this environment; `/ecc-doctor` is the in-session check.
