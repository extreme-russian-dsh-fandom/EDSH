/**
 * Tests for the DSH profile activation helper.
 *
 * Run with: node tests/dsh/activation.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const activate = require('../../scripts/dsh/activate');

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-activate-'));
  const profile = path.join(home, 'profiles', 'desktop');
  const bundle = path.join(home, 'ecc', 'bundle');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'package.json'), '{}\n');
  return { home, profile, bundle };
}

function runTests() {
  console.log('\n=== Testing DSH activation ===\n');

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

  test('builds patch rows with paths relative to the profile', () => {
    const { profile, bundle } = tempHome();
    const block = activate.buildManagedBlock(profile, bundle);
    assert.ok(block.includes(activate.MARKER_START));
    assert.ok(block.includes(activate.MARKER_END));
    assert.ok(block.includes('"../../ecc/bundle/skills.js"'));
    assert.ok(block.includes('"../../ecc/bundle/commands.js"'));
    assert.ok(block.includes('"../../ecc/bundle/hooks.js"'));
    assert.ok(block.includes('"../../ecc/bundle/agents.js"'));
    assert.ok(block.startsWith(activate.MARKER_START));
  });

  test('inserts, replaces, and removes the managed block idempotently', () => {
    const original = '# user patch\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n';
    const block = `${activate.MARKER_START}\nBLOCK\n${activate.MARKER_END}`;
    const once = activate.applyManagedBlock(original, block);
    const twice = activate.applyManagedBlock(once, block);
    assert.strictEqual(twice, once);
    assert.ok(once.startsWith('# user patch'));
    assert.ok(once.includes('BLOCK'));
    assert.strictEqual(activate.removeManagedBlock(once), original);
    assert.strictEqual(activate.removeManagedBlock(original), original);
  });

  test('patches a profile file and restores it exactly', () => {
    const { home, profile, bundle } = tempHome();
    const patchPath = path.join(profile, 'cordis.patch.yml');
    const original = '# user patch\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n';
    fs.writeFileSync(patchPath, original);

    const first = activate.patchProfile(profile, { bundleRoot: bundle });
    assert.strictEqual(first.changed, true);
    assert.ok(fs.readFileSync(patchPath, 'utf8').includes(activate.MARKER_START));

    const second = activate.patchProfile(profile, { bundleRoot: bundle });
    assert.strictEqual(second.changed, false);

    const removed = activate.patchProfile(profile, { bundleRoot: bundle, remove: true });
    assert.strictEqual(removed.changed, true);
    assert.strictEqual(fs.readFileSync(patchPath, 'utf8'), original);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('dry-run reports a change without writing', () => {
    const { home, profile, bundle } = tempHome();
    const patchPath = path.join(profile, 'cordis.patch.yml');
    fs.writeFileSync(patchPath, '# user patch\n');
    const result = activate.patchProfile(profile, { bundleRoot: bundle, dryRun: true });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(fs.readFileSync(patchPath, 'utf8'), '# user patch\n');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('lists profiles and rejects an unknown one', () => {
    const { home } = tempHome();
    assert.deepStrictEqual(activate.listProfiles(home), ['desktop']);
    const exitCode = activate.main([
      'node',
      'activate.js',
      '--dsh-home',
      home,
      '--profile',
      'missing',
    ]);
    assert.strictEqual(exitCode, 1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('refuses to activate without an installed bundle', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dsh-missing-'));
    const profile = path.join(home, 'profiles', 'desktop');
    fs.mkdirSync(profile, { recursive: true });
    const exitCode = activate.main([
      'node',
      'activate.js',
      '--dsh-home',
      home,
      '--profile',
      'desktop',
    ]);
    assert.strictEqual(exitCode, 1);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('parses profile and DSH home arguments', () => {
    const options = activate.parseArgs([
      'node',
      'activate.js',
      '--dsh-home',
      '/tmp/dsh',
      '--profile',
      'desktop,headless',
      '--dry-run',
    ]);
    assert.strictEqual(options.dshHome, path.resolve('/tmp/dsh'));
    assert.deepStrictEqual(options.profiles, ['desktop', 'headless']);
    assert.strictEqual(options.dryRun, true);
  });

  console.log('');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

process.exit(runTests() ? 0 : 1);
