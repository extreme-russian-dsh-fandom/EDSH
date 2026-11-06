/**
 * ECC skill catalog as a DeepSeek Harness skill provider.
 *
 * The provider reads the canonical `<eccRoot>/skills/<name>/SKILL.md` files.
 * Discovery is intentionally cheap: only frontmatter is parsed for the
 * catalog, while every `get` re-reads the current body so editing a skill
 * needs no restart or cache invalidation.
 */

import path from 'node:path';
import { listDirectories, isFile, readTextFile, isPathInside } from './fs-utils.js';
import { parseBoolean, parseMarkdownDocument } from './markdown.js';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ECC_SKILL_PROVIDER = 'ecc';
export const ECC_SKILL_RANK = 600;

function skillName(value, fallback) {
  const candidate = String(value ?? '').trim();
  return NAME_PATTERN.test(candidate) ? candidate : fallback;
}

function normalizeDescription(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function invocationPolicy(data) {
  const model = parseBoolean(data['disable-model-invocation']);
  const user = parseBoolean(data['user-invocable']);
  return {
    modelInvocable: model !== true,
    userInvocable: user !== false,
  };
}

/**
 * Read every valid skill bundle under `skillsRoot`.
 *
 * @param {string} skillsRoot
 * @returns {{ candidates: object[], skipped: object[] }}
 */
export function readSkillCatalog(skillsRoot) {
  const candidates = [];
  const skipped = [];
  const seen = new Set();

  for (const directory of listDirectories(skillsRoot)) {
    const directoryPath = path.join(skillsRoot, directory);
    const skillPath = path.join(directoryPath, 'SKILL.md');
    if (!isFile(skillPath)) {
      skipped.push({ directory, path: skillPath, reason: 'SKILL.md missing' });
      continue;
    }

    let document;
    try {
      document = parseMarkdownDocument(readTextFile(skillPath));
    } catch (error) {
      skipped.push({ directory, path: skillPath, reason: `read failed: ${error.message}` });
      continue;
    }

    const name = skillName(document.data.name, directory);
    if (!NAME_PATTERN.test(name)) {
      skipped.push({ directory, path: skillPath, reason: 'invalid skill name' });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ directory, path: skillPath, reason: `duplicate skill "${name}"` });
      continue;
    }

    const description = normalizeDescription(document.data.description);
    if (description === '') {
      skipped.push({ directory, path: skillPath, reason: 'description missing' });
      continue;
    }

    seen.add(name);
    candidates.push({
      name,
      description,
      whenToUse: normalizeDescription(document.data.whenToUse ?? document.data.when_to_use) || undefined,
      invocation: invocationPolicy(document.data),
      source: 'bundled',
      provider: ECC_SKILL_PROVIDER,
      rank: ECC_SKILL_RANK,
      path: skillPath,
      locator: skillPath,
      resourceBase: { kind: 'directory', path: directoryPath },
      metadata: document.data.metadata && typeof document.data.metadata === 'object'
        ? document.data.metadata
        : undefined,
    });
  }

  candidates.sort((left, right) => left.name.localeCompare(right.name));
  skipped.sort((left, right) => left.directory.localeCompare(right.directory));
  return { candidates, skipped };
}

/**
 * Load one skill body from its locator.
 *
 * @param {object} candidate
 * @param {string} skillsRoot
 * @returns {object|undefined}
 */
export function readSkillDefinition(candidate, skillsRoot) {
  const locator = typeof candidate.locator === 'string' ? candidate.locator : candidate.path;
  if (typeof locator !== 'string' || locator === '') return undefined;
  if (!isPathInside(skillsRoot, locator) || !isFile(locator)) return undefined;

  const document = parseMarkdownDocument(readTextFile(locator));
  const name = skillName(document.data.name, candidate.name);
  if (name !== candidate.name) return undefined;

  const description = normalizeDescription(document.data.description);
  if (description === '') return undefined;

  return {
    name,
    description,
    whenToUse: normalizeDescription(document.data.whenToUse ?? document.data.when_to_use) || undefined,
    invocation: invocationPolicy(document.data),
    source: 'bundled',
    provider: ECC_SKILL_PROVIDER,
    path: locator,
    resourceBase: { kind: 'directory', path: path.dirname(locator) },
    content: document.body.trim(),
    metadata: candidate.metadata,
  };
}
