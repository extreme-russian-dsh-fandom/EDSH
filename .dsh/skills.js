/**
 * ECC skill provider for DeepSeek Harness.
 *
 * Registers the canonical `skills/` catalog on the global skills layer. It is
 * a Host row, so every agent preset sees the same ECC skills without copying
 * files into a user skill root.
 */

import { defaultEccRoot } from './lib/paths.js';
import { resolveSkillsConfig } from './lib/config.js';
import {
  ECC_SKILL_PROVIDER,
  readSkillCatalog,
  readSkillDefinition,
} from './lib/skill-catalog.js';

export const name = 'ecc-skills';
export const inject = ['skills'];

const DEFAULT_ECC_ROOT = defaultEccRoot(import.meta.url);

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveSkillsConfig(rawConfig, {
    eccRoot: DEFAULT_ECC_ROOT,
    enabled: true,
    skillsDir: 'skills',
    cacheTtlMs: 5000,
  });
  if (!config.enabled) return;

  const warned = new Set();
  const warn = message => {
    if (!config.logWarnings || warned.has(message)) return;
    warned.add(message);
    ctx.logger?.warn?.(`[ecc-skills] ${message}`);
  };

  let cache = null;
  let cachedAt = 0;

  ctx.effect(() => ctx.skills.registerProvider(() => ({
    name: ECC_SKILL_PROVIDER,
    async list() {
      const now = Date.now();
      if (cache !== null && now - cachedAt < config.cacheTtlMs) {
        return { candidates: cache, complete: true };
      }
      try {
        const result = readSkillCatalog(config.skillsDir);
        for (const skipped of result.skipped) {
          warn(`skipped ${skipped.directory}: ${skipped.reason}`);
        }
        cache = result.candidates;
        cachedAt = now;
        return { candidates: cache, complete: true };
      } catch (error) {
        warn(`skill discovery failed: ${error.message}`);
        return { candidates: [], complete: false };
      }
    },
    async get(candidate) {
      try {
        return readSkillDefinition(candidate, config.skillsDir);
      } catch (error) {
        warn(`skill "${candidate?.name ?? '?'}" failed to load: ${error.message}`);
        return undefined;
      }
    },
  })), 'ecc skills provider');
}
