/**
 * Small filesystem helpers used by the ECC catalogs.
 */

import fs from 'node:fs';
import path from 'node:path';

export function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

export function readTextFile(value) {
  return fs.readFileSync(value, 'utf8');
}

export function listDirectories(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function listFiles(root, extension) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }

  return entries
    .filter(entry => entry.isFile() && (!extension || entry.name.endsWith(extension)))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
