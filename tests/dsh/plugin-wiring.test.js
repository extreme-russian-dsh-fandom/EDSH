/**
 * Tests for the ECC DeepSeek Harness plugin entries.
 *
 * Run with: node tests/dsh/plugin-wiring.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const repoRoot = path.resolve(__dirname, '..', '..');
const dshRoot = path.join(repoRoot, '.dsh');

function importDsh(relativePath) {
  return import(pathToFileURL(path.join(dshRoot, relativePath)).href);
}

function createContext() {
  const effects = [];
  const listeners = new Map();
  const commands = [];
  const tools = [];
  const providers = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(factory, label) {
      const dispose = factory();
      if (typeof dispose !== 'function') {
        throw new Error(`effect ${label} did not return a disposer`);
      }
      effects.push(dispose);
      return dispose;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        listeners.set(event, current.filter(item => item !== listener));
      };
    },
    get() {
      return undefined;
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
    skills: {
      registerProvider(factory) {
        providers.push(factory({ signal: new AbortController().signal, invalidate() {} }));
        return () => {};
      },
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, effects, listeners, commands, tools, providers };
}

async function runTests() {
  console.log('\n=== Testing DSH plugin wiring ===\n');

  const skills = await importDsh('skills.js');
  const commands = await importDsh('commands.js');
  const agents = await importDsh('agents.js');
  const hooks = await importDsh('hooks.js');

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`  \u2713 ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  \u2717 ${name}`);
      console.log(`    Error: ${error.message}`);
      failed += 1;
    }
  };

  await test('registers the ECC skill provider on the global skill layer', () => {
    const { ctx, providers, effects } = createContext();
    skills.apply(ctx, {});
    assert.strictEqual(providers.length, 1);
    assert.strictEqual(providers[0].name, 'ecc');
    assert.strictEqual(typeof providers[0].list, 'function');
    assert.strictEqual(typeof providers[0].get, 'function');
    assert.strictEqual(effects.length, 1);
  });

  await test('registers all ECC commands, the /ecc-plan alias, and /ecc-doctor', () => {
    const { ctx, commands: registrations, effects } = createContext();
    commands.apply(ctx, {});
    const names = registrations.map(item => item.name);
    assert.ok(names.includes('code-review'));
    assert.ok(names.includes('ecc-plan'));
    assert.ok(names.includes('ecc-doctor'));
    assert.ok(!names.includes('plan'));
    assert.strictEqual(new Set(names).size, names.length);
    assert.ok(names.length >= 99);
    assert.strictEqual(effects.length, 1);
  });

  await test('steers an expanded prompt when an ECC command runs', () => {
    const { ctx, commands: registrations } = createContext();
    commands.apply(ctx, {});
    const entry = registrations.find(item => item.name === 'code-review');
    assert.ok(entry);

    const steered = [];
    const result = entry.handler({
      agent: { steer(message) { steered.push(message); } },
      rawInput: '42',
    });

    assert.strictEqual(result.kind, 'success');
    assert.strictEqual(steered.length, 1);
    assert.ok(steered[0].content[0].text.includes('42'));
    assert.strictEqual(steered[0].source.kind, 'ecc-command');
  });

  await test('reports ECC counts from /ecc-doctor', () => {
    const { ctx, commands: registrations } = createContext();
    commands.apply(ctx, {});
    const doctor = registrations.find(item => item.name === 'ecc-doctor');
    assert.ok(doctor);
    const result = doctor.handler();
    assert.strictEqual(result.kind, 'success');
    assert.ok(result.text.includes('Skills: 314'));
    assert.ok(result.text.includes('Commands: 98'));
    assert.ok(result.text.includes('Agents: 71'));
    assert.ok(result.text.includes('PreCompact'));
  });

  await test('registers the ecc_agent delegation tool with all specialists', () => {
    const { ctx, tools, effects } = createContext();
    agents.apply(ctx, {});
    assert.strictEqual(tools.length, 1);
    const tool = tools[0];
    assert.strictEqual(tool.name, 'ecc_agent');
    assert.strictEqual(tool.parameters.properties.agent.enum.length, 71);
    assert.ok(tool.parameters.required.includes('task'));
    assert.ok(tool.description.includes('code-reviewer'));
    assert.strictEqual(effects.length, 1);
  });

  await test('ecc_agent rejects an unknown specialist before touching the subagent service', async () => {
    const { ctx, tools } = createContext();
    agents.apply(ctx, {});
    const tool = tools[0];
    let error = null;
    try {
      await tool.execute({ agent: 'no-such-agent', task: 'x' }, {
        agent: { id: 'session-1' },
        signal: new AbortController().signal,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.ok(error.message.includes('Unknown ECC agent'));
  });

  await test('registers every hook bridge listener', () => {
    const { ctx, listeners, effects } = createContext();
    hooks.apply(ctx, {});
    const events = [...listeners.keys()];
    assert.deepStrictEqual(events.sort(), [
      'agent/created',
      'agent/disposed',
      'agent/pre-step',
      'agent/turn-stopping',
      'subagent/end',
      'subagent/start',
      'tools/post-execute',
      'tools/pre-execute',
    ]);
    assert.strictEqual(effects.length, 1);
  });

  await test('cleanup disposers are callable', () => {
    const { ctx, effects } = createContext();
    skills.apply(ctx, {});
    commands.apply(ctx, {});
    agents.apply(ctx, {});
    hooks.apply(ctx, {});
    for (const dispose of effects) {
      assert.strictEqual(typeof dispose, 'function');
      dispose();
    }
  });

  console.log('');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

runTests().then(ok => process.exit(ok ? 0 : 1));
