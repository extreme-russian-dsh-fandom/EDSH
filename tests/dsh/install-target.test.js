/**
 * Tests for the DeepSeek Harness install target and bundle manifest.
 *
 * Run with: node tests/dsh/install-target.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getInstallTargetAdapter,
  planInstallTargetScaffold,
} = require('../../scripts/lib/install-targets/registry');
const { isForeignPlatformPath } = require('../../scripts/lib/install-targets/helpers');
const { SUPPORTED_INSTALL_TARGETS } = require('../../scripts/lib/install-manifests');

const repoRoot = path.resolve(__dirname, '..', '..');

function runTests() {
  console.log('\n=== Testing DSH install target ===\n');

  let passed = 0;
  let failed = 0;

  const test = (name, fn) => {
    try {
      fn();
      console.log(`  \u2713 ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  \u2717 ${name}`);
      console.log(`    Error: ${error.message}`);
      failed += 1;
    }
  };

  test('resolves the DSH home from DSH_HOME and the default', () => {
    const adapter = getInstallTargetAdapter('dsh');
    const homeDir = path.resolve('/Users/example');
    assert.strictEqual(adapter.id, 'dsh-home');
    assert.strictEqual(adapter.target, 'dsh');
    assert.strictEqual(adapter.kind, 'home');
    assert.strictEqual(
      adapter.resolveRoot({ homeDir, env: { DSH_HOME: '/custom/dsh' } }),
      path.resolve('/custom/dsh')
    );
    assert.strictEqual(
      adapter.resolveRoot({ homeDir, env: {} }),
      path.join(homeDir, '.dsh')
    );
    assert.strictEqual(
      adapter.getInstallStatePath({ homeDir, env: {} }),
      path.join(homeDir, '.dsh', 'ecc', 'install-state.json')
    );
  });

  test('plans bundle, skills, commands, agents, hooks, and runtime scripts', () => {
    const homeDir = path.join(os.tmpdir(), 'ecc-dsh-plan-home');
    const plan = planInstallTargetScaffold({
      target: 'dsh',
      repoRoot,
      homeDir,
      env: {},
      modules: [
        { id: 'platform-configs', paths: ['.dsh', '.cursor', 'mcp-configs'] },
        { id: 'workflow-quality', paths: ['skills/tdd-workflow', 'skills/code-review'] },
        { id: 'commands-core', paths: ['commands'] },
        { id: 'agents-core', paths: ['.agents', 'agents', 'AGENTS.md'] },
        { id: 'hooks-runtime', paths: ['hooks', 'scripts/hooks', 'scripts/lib'] },
      ],
    });

    const destination = relativePath => plan.operations.find(operation => (
      operation.sourceRelativePath.split(path.sep).join('/') === relativePath
    ));

    assert.strictEqual(plan.adapter.id, 'dsh-home');
    assert.strictEqual(plan.targetRoot, path.join(homeDir, '.dsh'));
    assert.strictEqual(
      destination('.dsh').destinationPath,
      path.join(homeDir, '.dsh', 'ecc', 'bundle')
    );
    assert.strictEqual(destination('.dsh').strategy, 'sync-root-children');
    assert.strictEqual(
      destination('skills/tdd-workflow').destinationPath,
      path.join(homeDir, '.dsh', 'ecc', 'skills', 'tdd-workflow')
    );
    assert.strictEqual(
      destination('commands').destinationPath,
      path.join(homeDir, '.dsh', 'ecc', 'commands')
    );
    assert.strictEqual(
      destination('agents').destinationPath,
      path.join(homeDir, '.dsh', 'ecc', 'agents')
    );
    assert.strictEqual(
      destination('hooks').destinationPath,
      path.join(homeDir, '.dsh', 'ecc', 'hooks')
    );
    assert.strictEqual(
      destination('scripts/hooks').destinationPath,
      path.join(homeDir, '.dsh', 'ecc', 'scripts', 'hooks')
    );
    assert.strictEqual(destination('AGENTS.md'), undefined);
    assert.strictEqual(destination('.agents'), undefined);
    assert.strictEqual(destination('.cursor'), undefined);
  });

  test('keeps every DSH operation inside the ECC runtime root', () => {
    const homeDir = path.join(os.tmpdir(), 'ecc-dsh-bound-home');
    const plan = planInstallTargetScaffold({
      target: 'dsh',
      repoRoot,
      homeDir,
      env: {},
      modules: [{ id: 'platform-configs', paths: ['.dsh', 'mcp-configs'] }],
    });
    const root = path.join(homeDir, '.dsh', 'ecc');
    assert.ok(plan.operations.every(operation => (
      operation.destinationPath === root || operation.destinationPath.startsWith(`${root}${path.sep}`)
    )));
  });

  test('rejects an install without the .dsh bundle', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-empty-'));
    const adapter = getInstallTargetAdapter('dsh');
    const issues = adapter.validate({ homeDir: temporary, repoRoot: temporary });
    assert.ok(issues.some(issue => issue.code === 'dsh-bundle-not-found'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  test('accepts the real checkout bundle', () => {
    const adapter = getInstallTargetAdapter('dsh');
    const issues = adapter.validate({ homeDir: os.tmpdir(), repoRoot });
    assert.deepStrictEqual(issues, []);
  });

  test('treats .dsh as foreign to every other install target', () => {
    assert.strictEqual(isForeignPlatformPath('.dsh', 'cursor'), true);
    assert.strictEqual(isForeignPlatformPath('.dsh/commands.js', 'claude'), true);
    assert.strictEqual(isForeignPlatformPath('.dsh', 'dsh'), false);
  });

  test('registers dsh in the installer target list and schema', () => {
    assert.ok(SUPPORTED_INSTALL_TARGETS.includes('dsh'));
    const schema = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'schemas', 'ecc-install-config.schema.json'),
      'utf8'
    ));
    assert.ok(schema.properties.target.enum.includes('dsh'));
  });

  test('ships a valid DSH bundle manifest and patch', () => {
    const bundleRoot = path.join(repoRoot, '.dsh');
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf8'));
    assert.strictEqual(manifest.name, '@ecc/dsh');
    assert.strictEqual(manifest.type, 'module');
    assert.strictEqual(manifest.dsh.bundle.patch, './cordis.patch.yml');

    for (const relative of [
      'index.js',
      'commands.js',
      'hooks.js',
      'agents.js',
      'skills.js',
      'cordis.patch.yml',
      'locale/en.json',
      'icon.svg',
    ]) {
      assert.ok(fs.existsSync(path.join(bundleRoot, relative)), `missing ${relative}`);
    }

    const patch = fs.readFileSync(path.join(bundleRoot, 'cordis.patch.yml'), 'utf8');
    for (const id of ['ecc-skills', 'ecc-commands', 'ecc-hooks', 'ecc-agents']) {
      assert.ok(patch.includes(`id: ${id}`), `missing ${id} row`);
    }

    const locale = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'locale', 'en.json'), 'utf8'));
    assert.ok(locale.meta.title.includes('ECC'));
    assert.ok(locale.meta.description.includes('DeepSeek Harness'));
  });

  test('installs DSH as an advanced harness capability with the right root', () => {
    const { getHarnessCapability } = require('../../scripts/lib/harness-capabilities');
    const capability = getHarnessCapability('dsh');
    assert.ok(capability);
    assert.strictEqual(capability.label, 'DeepSeek Harness');
    assert.deepStrictEqual(capability.scopes.map(scope => scope.root), ['~/.dsh']);
  });

  console.log('');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
