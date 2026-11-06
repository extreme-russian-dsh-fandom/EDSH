/**
 * Tests for the ECC DeepSeek Harness catalogs.
 *
 * Run with: node tests/dsh/catalog.test.js
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

async function runTests() {
  console.log('\n=== Testing DSH catalogs ===\n');

  const commandCatalog = await importDsh('lib/command-catalog.js');
  const agentCatalog = await importDsh('lib/agent-catalog.js');
  const skillCatalog = await importDsh('lib/skill-catalog.js');

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

  await test('reads every command file and names it safely', () => {
    const result = commandCatalog.readCommandCatalog(path.join(repoRoot, 'commands'));
    assert.strictEqual(result.entries.length, 98);
    assert.strictEqual(result.skipped.length, 0);
    assert.ok(result.entries.every(entry => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)));
    assert.ok(result.entries.every(entry => entry.description.length > 0));
  });

  await test('aliases the DSH-owned /plan command instead of colliding', () => {
    const result = commandCatalog.readCommandCatalog(path.join(repoRoot, 'commands'));
    const { registrations, conflicts } = commandCatalog.buildCommandRegistrations(result.entries);
    assert.ok(conflicts.some(item => item.name === 'plan' && item.alias === 'ecc-plan'));
    assert.ok(registrations.some(entry => entry.name === 'ecc-plan'));
    assert.ok(!registrations.some(entry => entry.name === 'plan'));
    assert.strictEqual(registrations.length, result.entries.length);
  });

  await test('expands $ARGUMENTS and positional placeholders', () => {
    const entry = { body: 'Review $1 against $2. Input: $ARGUMENTS', hasArguments: true };
    const output = commandCatalog.expandCommandPrompt(entry, 'one "two words"');
    assert.ok(output.includes('Review one against two words.'));
    assert.ok(output.includes('Input: one "two words"'));
  });

  await test('does not re-expand placeholder text inside the user input', () => {
    const entry = { body: 'Use $ARGUMENTS', hasArguments: true };
    const output = commandCatalog.expandCommandPrompt(entry, 'literal $1 and $2');
    assert.ok(output.includes('Use literal $1 and $2'));
  });

  await test('appends unclaimed input when a command has no placeholder', () => {
    const entry = { body: 'Run the workflow.', hasArguments: false };
    const output = commandCatalog.expandCommandPrompt(entry, 'focus on auth');
    assert.ok(output.includes('## User Input'));
    assert.ok(output.includes('focus on auth'));
  });

  await test('reads every ECC agent with tools and a role prompt', () => {
    const result = agentCatalog.readAgentCatalog(path.join(repoRoot, 'agents'));
    assert.strictEqual(result.agents.length, 71);
    assert.strictEqual(result.skipped.length, 0);
    const planner = result.agents.find(agent => agent.name === 'planner');
    assert.ok(planner);
    assert.ok(planner.tools.includes('Read'));
    assert.ok(planner.prompt.includes('planning specialist'));
  });

  await test('builds a delegated task prompt with the role and the task', () => {
    const agent = {
      name: 'code-reviewer',
      tools: ['Read', 'Grep'],
      prompt: 'Review code carefully.',
    };
    const prompt = agentCatalog.buildAgentTaskPrompt(agent, 'Review src/index.js');
    assert.ok(prompt.includes('ECC "code-reviewer" specialist'));
    assert.ok(prompt.includes('Review code carefully.'));
    assert.ok(prompt.includes('Review src/index.js'));
    assert.ok(prompt.includes('Working agreement'));
  });

  await test('renders the agent directory within its character budget', () => {
    const agents = Array.from({ length: 80 }, (_value, index) => ({
      name: `agent-${index}`,
      description: 'A specialist with a deliberately long description that must be shortened.',
    }));
    const directory = agentCatalog.renderAgentDirectory(agents, 500);
    assert.ok(directory.length <= 500 + 40);
    assert.ok(directory.includes('more specialists'));
  });

  await test('reads all 314 skills with invocation policy', () => {
    const result = skillCatalog.readSkillCatalog(path.join(repoRoot, 'skills'));
    assert.strictEqual(result.candidates.length, 314);
    assert.strictEqual(result.skipped.length, 0);
    assert.ok(result.candidates.every(skill => skill.invocation.modelInvocable === true));
    assert.ok(result.candidates.every(skill => skill.provider === 'ecc'));
  });

  await test('loads a skill body from its locator', () => {
    const root = path.join(repoRoot, 'skills');
    const result = skillCatalog.readSkillCatalog(root);
    const candidate = result.candidates.find(skill => skill.name === 'tdd-workflow');
    assert.ok(candidate);
    const definition = skillCatalog.readSkillDefinition(candidate, root);
    assert.ok(definition);
    assert.ok(definition.content.length > 100);
    assert.strictEqual(definition.name, 'tdd-workflow');
  });

  await test('rejects a skill locator outside the skill root', () => {
    const definition = skillCatalog.readSkillDefinition(
      { name: 'escape', locator: path.join(repoRoot, 'README.md') },
      path.join(repoRoot, 'skills')
    );
    assert.strictEqual(definition, undefined);
  });

  console.log('');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

runTests().then(ok => process.exit(ok ? 0 : 1));
