/**
 * Tests for the ECC DeepSeek Harness hook bridge.
 *
 * Run with: node tests/dsh/hook-bridge.test.js
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

const HOOK_CONFIG = {
  timeoutSeconds: 0,
  maxTimeoutSeconds: 60,
  asyncHooks: true,
  maxInputBytes: 1048576,
  maxOutputBytes: 2097152,
  stopBlockingTimeoutSeconds: 30,
};

async function runTests() {
  console.log('\n=== Testing DSH hook bridge ===\n');

  const catalog = await importDsh('lib/hook-catalog.js');
  const protocol = await importDsh('lib/hook-protocol.js');
  const runner = await importDsh('lib/hook-runner.js');
  const shellWords = await importDsh('lib/shell-words.js');

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

  await test('loads all 27 ECC hook commands and reports PreCompact as unsupported', () => {
    const loaded = catalog.loadHooksConfig(path.join(repoRoot, 'hooks', 'hooks.json'));
    assert.strictEqual(loaded.commandCount, 27);
    assert.ok(loaded.warnings.some(warning => warning.includes('PreCompact')));
    assert.strictEqual(loaded.events.PreToolUse.length, 10);
  });

  await test('maps Claude matchers onto DSH tool names', () => {
    assert.strictEqual(catalog.toClaudeToolName('bash'), 'Bash');
    assert.strictEqual(catalog.toClaudeToolName('pwsh'), 'PowerShell');
    assert.strictEqual(catalog.toClaudeToolName('write'), 'Write');
    assert.strictEqual(catalog.toClaudeToolName('edit'), 'Edit');
    assert.ok(catalog.matchesToolMatcher('Bash', 'Bash'));
    assert.ok(catalog.matchesToolMatcher('Edit|MultiEdit', 'Edit'));
    assert.ok(catalog.matchesToolMatcher('.*', 'Write'));
    assert.ok(!catalog.matchesToolMatcher('Bash', 'Write'));
    assert.ok(catalog.matchesToolMatcher('^mcp__github', 'mcp__github__pr'));
  });

  await test('parses every shipped hook command as a direct node invocation', () => {
    const loaded = catalog.loadHooksConfig(path.join(repoRoot, 'hooks', 'hooks.json'));
    let count = 0;
    for (const groups of Object.values(loaded.events)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const parsed = catalog.parseHookCommand(hook.command);
          assert.strictEqual(parsed.kind, 'node');
          assert.strictEqual(parsed.args[0], '-e');
          count += 1;
        }
      }
    }
    assert.strictEqual(count, 27);
  });

  await test('selects hooks by event and matcher', () => {
    const loaded = catalog.loadHooksConfig(path.join(repoRoot, 'hooks', 'hooks.json'));
    const bashHooks = catalog.selectHooks(loaded, 'PreToolUse', 'Bash');
    const writeHooks = catalog.selectHooks(loaded, 'PreToolUse', 'Write');
    assert.ok(bashHooks.length >= 3);
    assert.ok(writeHooks.length >= 3);
    assert.ok(bashHooks.some(hook => hook.command.includes('pre-bash-dispatcher')));
    assert.ok(writeHooks.some(hook => hook.command.includes('gateguard-fact-force')));
  });

  await test('splits hook commands without losing quoted JavaScript', () => {
    assert.deepStrictEqual(
      shellWords.splitShellWords('node -e "const x = \'a b\';" node scripts/a.js --flag'),
      ['node', '-e', "const x = 'a b';", 'node', 'scripts/a.js', '--flag']
    );
    assert.deepStrictEqual(
      shellWords.splitShellWords("echo 'hello world' \"two words\""),
      ['echo', 'hello world', 'two words']
    );
  });

  await test('maps DSH tool arguments into Claude hook input', () => {
    assert.deepStrictEqual(
      protocol.mapToolInput('write', { path: 'src/a.js', content: 'x' }),
      { file_path: 'src/a.js', content: 'x' }
    );
    assert.deepStrictEqual(
      protocol.mapToolInput('edit', { path: 'src/a.js', old_string: 'a', new_string: 'b' }),
      { file_path: 'src/a.js', old_string: 'a', new_string: 'b', replace_all: undefined }
    );
    assert.strictEqual(
      protocol.mapToolInput('bash', { command: 'npm test', description: 'run tests' }).command,
      'npm test'
    );
  });

  await test('builds the documented hook stdin document', () => {
    const input = protocol.buildHookInput({
      event: 'PreToolUse',
      sessionId: 'session-1',
      cwd: '/workspace/app',
      toolName: 'bash',
      toolArguments: { command: 'echo hi' },
      toolCallId: 'call-1',
    });
    assert.strictEqual(input.hook_event_name, 'PreToolUse');
    assert.strictEqual(input.session_id, 'session-1');
    assert.strictEqual(input.cwd, '/workspace/app');
    assert.strictEqual(input.tool_name, 'Bash');
    assert.strictEqual(input.tool_input.command, 'echo hi');
    assert.strictEqual(input.tool_use_id, 'call-1');
  });

  await test('parses permission, block, context, and plain-text hook outputs', () => {
    assert.deepStrictEqual(
      protocol.parseHookOutput(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'no',
        },
      }), 'PreToolUse').permissionDecision,
      'deny'
    );
    assert.strictEqual(
      protocol.parseHookOutput(JSON.stringify({ decision: 'block', reason: 'stop' }), 'Stop').blocked,
      true
    );
    assert.strictEqual(
      protocol.parseHookOutput(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note' },
      }), 'PostToolUse').additionalContext,
      'note'
    );
    assert.strictEqual(
      protocol.parseHookOutput('remember this', 'UserPromptSubmit').additionalContext,
      'remember this'
    );
  });

  await test('merges deny, ask, block, and context across hook results', () => {
    const denied = protocol.mergeHookResults([
      { hook: { id: 'a' }, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }), code: 0 },
      { hook: { id: 'b' }, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } }), code: 0 },
      { hook: { id: 'c' }, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'note' } }), code: 0 },
    ], 'PreToolUse');
    assert.strictEqual(denied.permissionDecision, 'deny');
    assert.strictEqual(denied.reason, 'no');
    assert.strictEqual(denied.additionalContext, 'note');

    const asked = protocol.mergeHookResults([
      { hook: { id: 'a' }, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'confirm' } }), code: 0 },
    ], 'PreToolUse');
    assert.strictEqual(asked.permissionDecision, 'ask');

    const blocked = protocol.mergeHookResults([
      { hook: { id: 'a' }, stdout: JSON.stringify({ decision: 'block', reason: 'finish work' }), code: 0 },
    ], 'Stop');
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.reason, 'finish work');
  });

  await test('treats exit code 2 as a blocking hook decision', () => {
    const merged = protocol.mergeHookResults([
      { hook: { id: 'deny' }, stdout: '', stderr: 'blocked by policy', code: 2 },
    ], 'PreToolUse');
    assert.strictEqual(merged.permissionDecision, 'deny');
    assert.ok(merged.reason.includes('blocked by policy'));
  });

  await test('runs a real hook command and returns its decision', async () => {
    const hooks = [{
      id: 'deny',
      command: 'node -e "const fs=require(\'fs\');let s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:\'PreToolUse\',permissionDecision:\'deny\',permissionDecisionReason:\'blocked \'+i.tool_name}}))})"',
      timeout: 5,
      async: false,
    }];
    const input = protocol.buildHookInput({
      event: 'PreToolUse',
      sessionId: 's',
      cwd: repoRoot,
      toolName: 'bash',
      toolArguments: { command: 'echo hi' },
    });
    const { merged } = await runner.runHooks(hooks, {
      event: 'PreToolUse',
      input,
      env: process.env,
      cwd: repoRoot,
      config: HOOK_CONFIG,
    });
    assert.strictEqual(merged.permissionDecision, 'deny');
    assert.ok(merged.reason.includes('Bash'));
  });

  await test('kills a hook that exceeds its timeout', async () => {
    const hooks = [{
      id: 'slow',
      command: 'node -e "setTimeout(()=>{},5000)"',
      timeout: 1,
      async: false,
    }];
    const { results, merged } = await runner.runHooks(hooks, {
      event: 'SessionStart',
      input: protocol.buildHookInput({ event: 'SessionStart', sessionId: 's', cwd: repoRoot }),
      env: process.env,
      cwd: repoRoot,
      config: { ...HOOK_CONFIG, maxTimeoutSeconds: 1 },
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].timedOut, true);
    assert.ok(merged.warnings.some(warning => warning.includes('timed out')));
  });

  await test('truncates an oversized tool response instead of sending invalid JSON', () => {
    const input = protocol.buildHookInput({
      event: 'PostToolUse',
      sessionId: 's',
      cwd: repoRoot,
      toolName: 'read',
      toolArguments: { path: 'big.txt' },
      toolResult: { isError: false, content: [{ type: 'text', text: 'x'.repeat(200000) }] },
    });
    const serialized = runner.serializeHookInput(input, 65536);
    assert.strictEqual(serialized.truncated, true);
    const parsed = JSON.parse(serialized.text);
    assert.strictEqual(parsed.tool_response.truncated, true);
  });

  console.log('');
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  return failed === 0;
}

runTests().then(ok => process.exit(ok ? 0 : 1));
