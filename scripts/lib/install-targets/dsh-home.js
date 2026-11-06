const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildValidationIssue,
  createInstallTargetAdapter,
  createManagedOperation,
  isForeignPlatformPath,
} = require('./helpers');

const DSH_HOME_ENV = 'DSH_HOME';

function expandHome(value, homeDir) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homeDir, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

/**
 * Resolve the DSH home. The harness prefers DSH_HOME; the default is ~/.dsh.
 * An explicit homeDir argument still isolates tests from ambient overrides.
 */
function resolveDshHome(input = {}) {
  const homeDir = path.resolve(input.homeDir || os.homedir());
  const configured = expandHome((input.env || {})[DSH_HOME_ENV], homeDir);
  if (configured !== null) return configured;
  return path.join(homeDir, '.dsh');
}

function relativeToEcc(sourceRelativePath) {
  return String(sourceRelativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function destinationForSource(sourcePath, eccRoot) {
  const normalized = relativeToEcc(sourcePath);

  if (normalized === '.dsh') {
    return { destinationPath: path.join(eccRoot, 'bundle'), strategy: 'sync-root-children' };
  }
  if (normalized.startsWith('.dsh/')) {
    return {
      destinationPath: path.join(eccRoot, 'bundle', normalized.slice('.dsh/'.length)),
      strategy: 'preserve-relative-path',
    };
  }
  if (normalized === 'skills') {
    return { destinationPath: path.join(eccRoot, 'skills'), strategy: 'sync-root-children' };
  }
  if (normalized.startsWith('skills/')) {
    return {
      destinationPath: path.join(eccRoot, 'skills', normalized.slice('skills/'.length)),
      strategy: 'preserve-relative-path',
    };
  }
  if (normalized === 'commands' || normalized === 'agents' || normalized === 'hooks' || normalized === 'rules' || normalized === 'mcp-configs') {
    return {
      destinationPath: path.join(eccRoot, normalized),
      strategy: 'sync-root-children',
    };
  }
  if (normalized.startsWith('commands/') || normalized.startsWith('agents/') || normalized.startsWith('hooks/') || normalized.startsWith('rules/')) {
    return {
      destinationPath: path.join(eccRoot, normalized),
      strategy: 'preserve-relative-path',
    };
  }
  if (normalized.startsWith('scripts/')) {
    return {
      destinationPath: path.join(eccRoot, normalized),
      strategy: 'preserve-relative-path',
    };
  }

  return null;
}

function defaultValidateDshHome(input = {}) {
  const issues = [];

  if (!input.homeDir && !os.homedir()) {
    issues.push(buildValidationIssue(
      'error',
      'missing-home-dir',
      'homeDir is required for home install targets'
    ));
  }

  if (input.repoRoot) {
    const packagePath = path.join(input.repoRoot, '.dsh', 'package.json');
    let stat = null;
    try {
      stat = fs.statSync(packagePath);
    } catch (error) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    }
    if (stat === null) {
      issues.push(buildValidationIssue(
        'error',
        'dsh-bundle-not-found',
        'DeepSeek Harness install requires .dsh/package.json in the ECC checkout.',
        { missingPaths: [packagePath] }
      ));
    }
  }

  return issues;
}

module.exports = createInstallTargetAdapter({
  id: 'dsh-home',
  target: 'dsh',
  kind: 'home',
  rootSegments: ['.dsh'],
  resolveRoot: resolveDshHome,
  installStatePathSegments: ['ecc', 'install-state.json'],
  nativeRootRelativePath: null,
  planOperations(input, adapter) {
    const modules = Array.isArray(input.modules)
      ? input.modules
      : (input.module ? [input.module] : []);
    const eccRoot = path.join(adapter.resolveRoot(input), 'ecc');
    const operations = [];
    const seenDestinations = new Set();

    const push = operation => {
      const key = `${operation.sourceRelativePath}\u0000${operation.destinationPath}`;
      if (seenDestinations.has(key)) return;
      seenDestinations.add(key);
      operations.push(operation);
    };

    for (const module of modules) {
      const paths = Array.isArray(module.paths) ? module.paths : [];
      for (const sourcePath of paths) {
        const normalized = relativeToEcc(sourcePath);
        if (normalized === '' || normalized === 'AGENTS.md' || normalized === '.agents') continue;
        if (isForeignPlatformPath(normalized, 'dsh')) continue;

        const destination = destinationForSource(normalized, eccRoot);
        if (destination === null) continue;

        push(createManagedOperation({
          moduleId: module.id,
          sourceRelativePath: normalized,
          destinationPath: destination.destinationPath,
          strategy: destination.strategy,
        }));
      }
    }

    return operations;
  },
  validate: defaultValidateDshHome,
});
