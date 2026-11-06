#!/usr/bin/env node
/**
 * Activate the installed ECC bundle in one or more DeepSeek Harness profiles.
 *
 * The installer copies ECC to <DSH_HOME>/ecc. This script adds a managed
 * `insert` block to each profile's cordis.patch.yml, pointing at the bundle's
 * entry modules by relative path. No package-manager step is required, and
 * `--remove` restores the user's patch layer exactly.
 *
 * Usage:
 *   node scripts/dsh/activate.js [--profile <name>]... [--all-profiles]
 *                                [--dsh-home <dir>] [--remove] [--dry-run] [--json]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_START = '# >>> ECC for DeepSeek Harness (managed) >>>';
const MARKER_END = '# <<< ECC for DeepSeek Harness (managed) <<<';

const ENTRY_MODULES = Object.freeze([
  ['ecc-skills', 'skills.js'],
  ['ecc-commands', 'commands.js'],
  ['ecc-hooks', 'hooks.js'],
  ['ecc-agents', 'agents.js'],
]);

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function relativeModulePath(profileDir, bundleRoot, filename) {
  let relative = toPosix(path.relative(profileDir, path.join(bundleRoot, filename)));
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}

/**
 * Build the managed YAML block for one profile.
 *
 * @param {string} profileDir
 * @param {string} bundleRoot
 * @returns {string}
 */
function buildManagedBlock(profileDir, bundleRoot) {
  const rows = ENTRY_MODULES.map(([id, filename]) => {
    const modulePath = relativeModulePath(profileDir, bundleRoot, filename);
    return [
      `    - id: ${id}`,
      `      name: ${JSON.stringify(modulePath)}`,
    ].join('\n');
  });

  return [
    MARKER_START,
    '# Written by scripts/dsh/activate.js. Re-run after installing ECC; use',
    '# `node scripts/dsh/activate.js --remove` to roll back this block.',
    '- insert:',
    ...rows,
    MARKER_END,
  ].join('\n');
}

function findBlockRange(content) {
  const start = content.indexOf(MARKER_START);
  if (start < 0) return null;
  const end = content.indexOf(MARKER_END, start);
  if (end < 0) return null;
  return { start, end: end + MARKER_END.length };
}

/**
 * Insert or replace the managed block.
 *
 * @param {string} content
 * @param {string} block
 * @returns {string}
 */
function applyManagedBlock(content, block) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const range = findBlockRange(text);

  if (range !== null) {
    const before = text.slice(0, range.start).replace(/\n+$/, '');
    const after = text.slice(range.end).replace(/^\n+/, '');
    return `${before}${before === '' ? '' : '\n\n'}${block}${after === '' ? '' : `\n\n${after}`}\n`;
  }

  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}${trimmed === '' ? '' : '\n\n'}${block}\n`;
}

/**
 * Remove the managed block, preserving every unrelated line.
 *
 * @param {string} content
 * @returns {string}
 */
function removeManagedBlock(content) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const range = findBlockRange(text);
  if (range === null) return text;

  const before = text.slice(0, range.start).replace(/\n+$/, '');
  const after = text.slice(range.end).replace(/^\n+/, '');
  if (before === '' && after === '') return '';
  if (before === '') return `${after}\n`;
  if (after === '') return `${before}\n`;
  return `${before}\n\n${after}\n`;
}

function writeAtomic(filePath, content) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.ecc-${process.pid}.tmp`);
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backup = `${filePath}.ecc.bak`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(filePath, backup);
  }
  return backup;
}

function listProfiles(dshHome) {
  const profilesDir = path.join(dshHome, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }

  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Patch one profile patch file.
 *
 * @param {string} profileDir
 * @param {{
 *   bundleRoot: string,
 *   remove?: boolean,
 *   dryRun?: boolean,
 * }} options
 * @returns {{ path: string, changed: boolean, backup: string|null, content: string }}
 */
function patchProfile(profileDir, options) {
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const exists = fs.existsSync(patchPath);
  const previous = exists ? fs.readFileSync(patchPath, 'utf8') : '';
  const next = options.remove
    ? removeManagedBlock(previous)
    : applyManagedBlock(previous, buildManagedBlock(profileDir, options.bundleRoot));

  if (next === previous) {
    return { path: patchPath, changed: false, backup: null, content: previous };
  }
  if (!options.dryRun) {
    const backup = backupFile(patchPath);
    fs.mkdirSync(profileDir, { recursive: true });
    writeAtomic(patchPath, next);
    return { path: patchPath, changed: true, backup, content: next };
  }

  return { path: patchPath, changed: true, backup: null, content: next };
}

function parseArgs(argv) {
  const options = {
    dshHome: process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? path.resolve(process.env.DSH_HOME)
      : path.join(os.homedir(), '.dsh'),
    profiles: [],
    allProfiles: false,
    remove: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--all-profiles') {
      options.allProfiles = true;
    } else if (argument === '--remove') {
      options.remove = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--profile' || argument === '--dsh-home') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      if (argument === '--profile') {
        options.profiles.push(...value.split(',').map(item => item.trim()).filter(Boolean));
      } else {
        options.dshHome = path.resolve(value);
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function helpText() {
  return [
    'Usage: node scripts/dsh/activate.js [options]',
    '',
    'Options:',
    '  --profile <name>    Profile to patch; repeat or comma-separate for more',
    '  --all-profiles      Patch every profile under <DSH_HOME>/profiles',
    '  --dsh-home <dir>    DSH home (default: $DSH_HOME or ~/.dsh)',
    '  --remove            Remove the managed ECC block instead of installing it',
    '  --dry-run           Print the resulting patch without writing',
    '  --json              Emit a machine-readable result',
    '  --help              Show this help',
  ].join('\n');
}

function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  const profilesDir = path.join(options.dshHome, 'profiles');
  const available = listProfiles(options.dshHome);
  let selected = options.profiles;

  if (options.allProfiles || selected.length === 0) {
    selected = available;
  }
  if (selected.length === 0) {
    process.stderr.write(`[ECC] No DSH profiles found under ${profilesDir}\n`);
    return 1;
  }

  const unknown = selected.filter(name => !available.includes(name));
  if (unknown.length > 0) {
    process.stderr.write(`[ECC] Unknown profile(s): ${unknown.join(', ')}. Available: ${available.join(', ') || '(none)'}\n`);
    return 1;
  }

  const bundleRoot = path.join(options.dshHome, 'ecc', 'bundle');
  if (!options.remove && !fs.existsSync(path.join(bundleRoot, 'package.json'))) {
    process.stderr.write(`[ECC] ECC bundle not found at ${bundleRoot}. Run the installer first:\n`);
    process.stderr.write('  ./install.sh --profile core --target dsh\n');
    return 1;
  }

  const results = selected.map(profile => {
    const profileDir = path.join(profilesDir, profile);
    const result = patchProfile(profileDir, {
      bundleRoot,
      remove: options.remove,
      dryRun: options.dryRun,
    });
    return { profile, ...result };
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      dshHome: options.dshHome,
      profiles: selected,
      removed: options.remove,
      dryRun: options.dryRun,
      results: results.map(item => ({
        profile: item.profile,
        path: item.path,
        changed: item.changed,
        backup: item.backup,
      })),
    }, null, 2)}\n`);
    return 0;
  }

  for (const result of results) {
    const action = options.remove ? 'removed from' : 'activated in';
    process.stdout.write(`${result.changed ? 'ECC' : 'ECC already'} ${action} ${result.path}\n`);
    if (result.backup) process.stdout.write(`  backup: ${result.backup}\n`);
    if (options.dryRun && result.changed) {
      process.stdout.write(`  --- would write ---\n${result.content.split('\n').map(line => `  ${line}`).join('\n')}\n`);
    }
  }
  if (!options.dryRun) {
    process.stdout.write('\nRestart DeepSeek Harness (or start a new session) to load the ECC bundle.\n');
  }
  return 0;
}

module.exports = {
  ENTRY_MODULES,
  MARKER_END,
  MARKER_START,
  applyManagedBlock,
  buildManagedBlock,
  findBlockRange,
  helpText,
  listProfiles,
  main,
  parseArgs,
  patchProfile,
  removeManagedBlock,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    process.stderr.write(`[ECC] ${error.message}\n`);
    process.exitCode = 1;
  }
}
