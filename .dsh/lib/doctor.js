/**
 * Build a compact health report for the ECC DeepSeek Harness adapter.
 *
 * Shared by the in-session `/ecc-doctor` command and the standalone
 * `scripts/dsh/doctor.js` CLI so both report the same facts.
 */

import { readCommandCatalog, buildCommandRegistrations } from './command-catalog.js';
import { readAgentCatalog } from './agent-catalog.js';
import { readSkillCatalog } from './skill-catalog.js';
import { loadHooksConfig, countHooksByEvent, SUPPORTED_HOOK_EVENTS } from './hook-catalog.js';

function safeRead(label, reader, warnings) {
  try {
    return reader();
  } catch (error) {
    warnings.push(`${label}: ${error.message}`);
    return null;
  }
}

/**
 * @param {{
 *   eccRoot: string,
 *   commandsDir: string,
 *   agentsDir: string,
 *   skillsDir: string,
 *   hooksPath: string,
 *   includeDoctor?: boolean,
 * }} config
 * @returns {object}
 */
export function buildDoctorReport(config) {
  const warnings = [];

  const commands = safeRead('commands', () => readCommandCatalog(config.commandsDir), warnings) ?? {
    entries: [],
    skipped: [],
    warnings: [],
  };
  const registrations = buildCommandRegistrations(commands.entries, { includeAliases: true });

  const agents = safeRead('agents', () => readAgentCatalog(config.agentsDir), warnings) ?? {
    agents: [],
    skipped: [],
  };

  const skills = safeRead('skills', () => readSkillCatalog(config.skillsDir), warnings) ?? {
    candidates: [],
    skipped: [],
  };

  const hooks = safeRead('hooks', () => loadHooksConfig(config.hooksPath), warnings) ?? {
    events: {},
    warnings: [],
    commandCount: 0,
  };

  warnings.push(...commands.warnings);
  warnings.push(...hooks.warnings);
  for (const skipped of commands.skipped) warnings.push(`command ${skipped.name}: ${skipped.reason}`);
  for (const skipped of agents.skipped) warnings.push(`agent ${skipped.name}: ${skipped.reason}`);
  for (const skipped of skills.skipped) warnings.push(`skill ${skipped.directory}: ${skipped.reason}`);

  const hookCounts = countHooksByEvent(hooks);
  const unsupportedHooks = Object.keys(hookCounts).filter(
    event => !SUPPORTED_HOOK_EVENTS.includes(event)
  );

  return {
    eccRoot: config.eccRoot,
    commands: {
      total: commands.entries.length,
      registered: registrations.registrations.length,
      aliases: registrations.conflicts,
      skipped: commands.skipped.length,
    },
    agents: {
      total: agents.agents.length,
      skipped: agents.skipped.length,
    },
    skills: {
      total: skills.candidates.length,
      skipped: skills.skipped.length,
    },
    hooks: {
      commands: hooks.commandCount,
      byEvent: hookCounts,
      unsupported: unsupportedHooks,
    },
    warnings,
  };
}

/**
 * @param {object} report
 * @returns {string}
 */
export function formatDoctorReport(report) {
  const lines = [
    '# ECC on DeepSeek Harness',
    '',
    `- Root: \`${report.eccRoot}\``,
    `- Skills: ${report.skills.total} installed (${report.skills.skipped} skipped)`,
    `- Commands: ${report.commands.total} files, ${report.commands.registered} registered (${report.commands.skipped} skipped)`,
    `- Agents: ${report.agents.total} available (${report.agents.skipped} skipped)`,
    `- Hooks: ${report.hooks.commands} commands on ${Object.keys(report.hooks.byEvent).length} events`,
  ];

  if (report.commands.aliases.length > 0) {
    lines.push(
      `- Aliases: ${report.commands.aliases.map(item => `/${item.name} -> /${item.alias}`).join(', ')}`
    );
  }
  if (report.hooks.unsupported.length > 0) {
    lines.push(`- Unsupported hook events: ${report.hooks.unsupported.join(', ')}`);
  }

  lines.push('', '## Hook events', '');
  for (const [event, count] of Object.entries(report.hooks.byEvent).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${event}: ${count}`);
  }

  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}
