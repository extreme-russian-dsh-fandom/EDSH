/**
 * Path helpers shared by the ECC DeepSeek Harness plugin entries.
 *
 * A bundle installed from a local directory is linked, not copied, so the
 * bundle directory always sits one level below the ECC resource root:
 *
 *   <repo>/.dsh              -> <repo>
 *   ~/.dsh/ecc/bundle        -> ~/.dsh/ecc
 *
 * `eccRoot` can still be set explicitly in the row config for packed installs.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function moduleDirectory(importMetaUrl) {
  const filename = importMetaUrl.startsWith('file:')
    ? fileURLToPath(importMetaUrl)
    : importMetaUrl;
  return path.dirname(filename);
}

export function defaultEccRoot(importMetaUrl) {
  return path.resolve(moduleDirectory(importMetaUrl), '..');
}

export function resolveAbsolutePath(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : fallback;
  return path.resolve(candidate);
}

export function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}
