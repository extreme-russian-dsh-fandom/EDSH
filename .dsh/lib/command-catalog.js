/**
 * ECC command catalog and prompt expansion.
 *
 * ECC commands are Markdown prompts with a `description` and an optional
 * `argument-hint`. DeepSeek Harness commands are direct human actions, so the
 * adapter expands the prompt and steers it to the receiving agent instead of
 * sending the slash line as a model message.
 */

import path from 'node:path';
import { listFiles, readTextFile } from './fs-utils.js';
import { parseMarkdownDocument } from './markdown.js';

/**
 * Names owned by the shipped DSH composition. Registering one of these would
 * throw inside the command registry, so ECC registers an `ecc-` alias instead.
 */
export const RESERVED_COMMAND_NAMES = Object.freeze([
  'compact',
  'export',
  'feedback',
  'goal',
  'help',
  'model',
  'plan',
]);

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeDescription(value, maxLength) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeHint(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text;
}

function commandNameFromFile(filename) {
  return filename.replace(/\.md$/i, '');
}

/**
 * Read every command Markdown file directly under `commandsDir`.
 *
 * @param {string} commandsDir Directory containing `<name>.md` files.
 * @param {{ descriptionMaxLength?: number }} [options]
 * @returns {{ entries: object[], skipped: object[], warnings: string[] }}
 */
export function readCommandCatalog(commandsDir, options = {}) {
  const descriptionMaxLength = options.descriptionMaxLength ?? 300;
  const files = listFiles(commandsDir, '.md');
  const entries = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();

  for (const filename of files) {
    const sourcePath = path.join(commandsDir, filename);
    const name = commandNameFromFile(filename);
    if (!NAME_PATTERN.test(name)) {
      skipped.push({ name, sourcePath, reason: 'invalid name' });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, sourcePath, reason: 'duplicate name' });
      continue;
    }

    let document;
    try {
      document = parseMarkdownDocument(readTextFile(sourcePath));
    } catch (error) {
      skipped.push({ name, sourcePath, reason: `read failed: ${error.message}` });
      continue;
    }

    const body = document.body.trim();
    if (body === '') {
      skipped.push({ name, sourcePath, reason: 'empty body' });
      continue;
    }

    const description = normalizeDescription(document.data.description, descriptionMaxLength);
    if (description === '') {
      warnings.push(`command "${name}" has no description; using a generated one`);
    }

    seen.add(name);
    entries.push({
      name,
      description: description || `Run the ECC ${name} workflow.`,
      argumentHint: normalizeHint(document.data['argument-hint']),
      body,
      sourcePath,
      hasArguments: /\$ARGUMENTS|\$\{?[1-9]\}?/.test(body),
    });
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  skipped.sort((left, right) => left.name.localeCompare(right.name));
  return { entries, skipped, warnings };
}

/**
 * Split a free-form argument string into positional values while respecting
 * single and double quotes.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function splitArguments(input) {
  const text = String(input ?? '');
  const values = [];
  let current = '';
  let quote = '';
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      } else if (char === '\\' && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index];
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        values.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) values.push(current);
  return values;
}

/**
 * Expand one ECC command body for a DeepSeek Harness invocation.
 *
 * Supports `$ARGUMENTS`, `${ARGUMENTS}`, `$1` ... `$9`, and `${1}` ... `${9}`.
 * A command with no placeholder still receives the user's input as an
 * appended section so the intent is never silently dropped.
 *
 * @param {{ body: string, hasArguments?: boolean }} entry
 * @param {string} rawInput
 * @returns {string}
 */
export function expandCommandPrompt(entry, rawInput) {
  const input = String(rawInput ?? '').trim();
  const args = splitArguments(input);
  let output = String(entry.body ?? '');

  output = output.replace(
    /\$\{ARGUMENTS\}|\$ARGUMENTS|\$\{([1-9])\}|\$([1-9])/g,
    (match, braced, bare) => {
      if (match === '$ARGUMENTS' || match === '${ARGUMENTS}') return input;
      const index = Number(braced ?? bare) - 1;
      return args[index] ?? '';
    }
  );

  if (!entry.hasArguments && input !== '' && !output.includes(input)) {
    output = `${output.trimEnd()}\n\n## User Input\n\n${input}\n`;
  }

  return output.trim() === '' ? '' : `${output.trimEnd()}\n`;
}

/**
 * Build the command list ECC registers, including safe aliases for names the
 * DSH composition already owns.
 *
 * @param {object[]} entries
 * @param {{ includeAliases?: boolean }} [options]
 * @returns {{ registrations: object[], conflicts: object[] }}
 */
export function buildCommandRegistrations(entries, options = {}) {
  const includeAliases = options.includeAliases ?? true;
  const reserved = new Set(RESERVED_COMMAND_NAMES);
  const used = new Set(entries.map(entry => entry.name));
  const registrations = [];
  const conflicts = [];

  for (const entry of entries) {
    if (!reserved.has(entry.name)) {
      registrations.push(entry);
      continue;
    }

    const alias = `ecc-${entry.name}`;
    conflicts.push({ name: entry.name, alias, reason: 'name owned by DeepSeek Harness' });
    if (!includeAliases || used.has(alias) || !NAME_PATTERN.test(alias)) continue;

    used.add(alias);
    registrations.push({ ...entry, name: alias, aliasOf: entry.name });
  }

  return {
    registrations,
    conflicts,
  };
}
