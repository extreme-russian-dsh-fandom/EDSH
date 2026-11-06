/**
 * Minimal Markdown + YAML frontmatter reader.
 *
 * ECC's durable units are Markdown files with a small frontmatter block:
 * skills, agents, and commands. The DSH adapter must not add a YAML
 * dependency to a Host plugin, so this reader supports the subset those
 * files use: top-level `key: value`, quoted strings, simple `|` / `>` block
 * scalars, booleans, and arrays written as comma-separated text.
 */

const BOOLEAN_TRUE = new Set(['true', 'yes', 'on', '1']);
const BOOLEAN_FALSE = new Set(['false', 'no', 'off', '0']);

export function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return undefined;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      if (first === '"') {
        return inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return inner.replace(/''/g, "'");
    }
  }
  return trimmed;
}

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function indentation(line) {
  const match = /^(\s*)/.exec(line);
  return match === null ? 0 : match[1].length;
}

function parseFrontmatterBlock(block) {
  const data = {};
  const lines = block.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      index += 1;
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }

    const key = match[1];
    const rawValue = stripInlineComment(match[2] === undefined ? '' : match[2]).trim();

    if (rawValue === '|' || rawValue === '>') {
      const literal = rawValue === '|';
      const collected = [];
      const baseIndent = index + 1 < lines.length ? indentation(lines[index + 1]) : 0;
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.trim() === '') {
          collected.push('');
          index += 1;
          continue;
        }
        if (indentation(candidate) <= baseIndent && baseIndent > 0) break;
        if (indentation(candidate) === 0) break;
        collected.push(candidate.slice(Math.min(baseIndent, indentation(candidate))));
        index += 1;
      }
      data[key] = literal ? collected.join('\n').replace(/\n$/, '') : collected.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }

    if (rawValue === '') {
      // A nested mapping (for example skill `metadata`). ECC does not need
      // nested values, but consume the indented block so keys stay aligned.
      index += 1;
      while (index < lines.length && (lines[index].trim() === '' || indentation(lines[index]) > 0)) {
        index += 1;
      }
      data[key] = {};
      continue;
    }

    data[key] = stripQuotes(rawValue);
    index += 1;
  }

  return data;
}

/**
 * Split a Markdown document into frontmatter data and body.
 *
 * @param {string} text Raw file text.
 * @returns {{ data: Record<string, unknown>, body: string, hasFrontmatter: boolean }}
 */
export function parseMarkdownDocument(text) {
  const normalized = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized, hasFrontmatter: false };
  }

  const closing = normalized.indexOf('\n---', 4);
  if (closing < 0) {
    return { data: {}, body: normalized, hasFrontmatter: false };
  }

  const block = normalized.slice(4, closing);
  let body = normalized.slice(closing + 4);
  if (body.startsWith('\n')) body = body.slice(1);

  return {
    data: parseFrontmatterBlock(block),
    body,
    hasFrontmatter: true,
  };
}

export function splitCommaList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap(item => String(item).split(','))
      .map(item => item.trim())
      .filter(Boolean);
  }
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}
