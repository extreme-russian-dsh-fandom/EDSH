/**
 * POSIX-like word splitting for ECC hook commands.
 *
 * ECC hook commands are single strings such as
 * `node -e "const p = require('path')" node scripts/hooks/a.js`.
 * Running them through a real shell on every tool call is both slower and
 * platform-dependent, so the adapter splits the command itself and spawns
 * Node directly whenever the command starts with `node`.
 */

/**
 * @param {string} input
 * @returns {string[]}
 */
export function splitShellWords(input) {
  const text = String(input ?? '');
  const words = [];
  let current = '';
  let quote = '';
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote === "'") {
      if (char === "'") quote = '';
      else current += char;
      started = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = '';
      } else if (char === '\\' && index + 1 < text.length) {
        const next = text[index + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          index += 1;
        } else if (next === '\n') {
          index += 1;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (char === '\\' && index + 1 < text.length) {
      current += text[index + 1];
      index += 1;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) words.push(current);
  return words;
}
