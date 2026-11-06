/**
 * ECC slash commands for DeepSeek Harness.
 *
 * A DSH command runs directly against the receiving agent. ECC commands are
 * prompt templates, so the handler expands the template and steers it as the
 * next user-role input. The command result itself is rendered outside model
 * history, exactly like any other DSH command.
 */

import path from 'node:path';
import { defaultEccRoot } from './lib/paths.js';
import { resolveCommandsConfig } from './lib/config.js';
import {
  buildCommandRegistrations,
  expandCommandPrompt,
  readCommandCatalog,
} from './lib/command-catalog.js';
import { buildDoctorReport, formatDoctorReport } from './lib/doctor.js';

export const name = 'ecc-commands';
export const inject = ['commands'];

const DEFAULT_ECC_ROOT = defaultEccRoot(import.meta.url);
const MAX_RESULT_TEXT = 4000;

function pageText(text) {
  const value = String(text ?? '');
  return value.length <= MAX_RESULT_TEXT ? value : `${value.slice(0, MAX_RESULT_TEXT - 1)}...`;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveCommandsConfig(rawConfig, {
    eccRoot: DEFAULT_ECC_ROOT,
    enabled: true,
    commandsDir: 'commands',
    includeDoctor: true,
    includeAliases: true,
    descriptionMaxLength: 300,
  });
  if (!config.enabled) return;

  const warn = message => {
    if (config.logWarnings) ctx.logger?.warn?.(`[ecc-commands] ${message}`);
  };

  const catalog = readCommandCatalog(config.commandsDir, {
    descriptionMaxLength: config.descriptionMaxLength,
  });
  for (const skipped of catalog.skipped) {
    warn(`skipped ${skipped.name}: ${skipped.reason}`);
  }
  const { registrations, conflicts } = buildCommandRegistrations(catalog.entries, {
    includeAliases: config.includeAliases,
  });
  for (const conflict of conflicts) {
    warn(`/${conflict.name} is owned by the harness; registered /${conflict.alias} instead`);
  }

  ctx.effect(() => {
    const disposers = [];

    for (const entry of registrations) {
      const definition = {
        name: entry.name,
        description: entry.description,
        input: {
          hint: entry.argumentHint || '<arguments>',
        },
        handler({ agent, rawInput }) {
          const prompt = expandCommandPrompt(entry, rawInput);
          if (prompt === '') {
            return { kind: 'error', text: `ECC /${entry.name} produced an empty prompt.` };
          }
          if (typeof agent?.steer !== 'function') {
            return { kind: 'error', text: 'This agent cannot receive a steered prompt.' };
          }

          try {
            agent.steer({
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'ecc-command' },
            });
          } catch (error) {
            return { kind: 'error', text: `ECC /${entry.name} failed: ${error.message}` };
          }

          return {
            kind: 'success',
            text: pageText(`ECC /${entry.name} sent to the model.`),
          };
        },
      };

      try {
        disposers.push(ctx.commands.register(definition));
      } catch (error) {
        warn(`could not register /${entry.name}: ${error.message}`);
      }
    }

    if (config.includeDoctor) {
      try {
        disposers.push(ctx.commands.register({
          name: 'ecc-doctor',
          description: 'Report ECC skills, commands, agents, and hook coverage in this DeepSeek Harness session.',
          handler() {
            try {
              const report = buildDoctorReport({
                eccRoot: config.eccRoot,
                commandsDir: config.commandsDir,
                agentsDir: path.join(config.eccRoot, 'agents'),
                skillsDir: path.join(config.eccRoot, 'skills'),
                hooksPath: path.join(config.eccRoot, 'hooks', 'hooks.json'),
              });
              return { kind: 'success', text: formatDoctorReport(report) };
            } catch (error) {
              return { kind: 'error', text: `ECC doctor failed: ${error.message}` };
            }
          },
        }));
      } catch (error) {
        warn(`could not register /ecc-doctor: ${error.message}`);
      }
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // Disposal is best-effort during reloads.
        }
      }
    };
  }, 'ecc slash commands');
}
