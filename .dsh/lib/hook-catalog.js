/**
 * ECC hook configuration reader and Claude Code -> DeepSeek Harness matcher
 * mapping.
 *
 * The canonical `hooks.json` remains the single source of truth. This module
 * normalizes it without rewriting it, so hook profiles, disabled-hook flags,
 * timeouts, and command strings stay exactly what ECC ships.
 */

import fs from 'node:fs';
import { splitShellWords } from './shell-words.js';

export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
]);

export const SUPPORTED_HOOK_EVENTS = Object.freeze(
  HOOK_EVENTS.filter(event => event !== 'PreCompact')
);

export const CLAUDE_TOOL_NAMES = Object.freeze({
  bash: 'Bash',
  pwsh: 'PowerShell',
  powershell: 'PowerShell',
  write: 'Write',
  edit: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  skill: 'Skill',
  task: 'Task',
  subagent: 'Task',
  subagent_fork: 'Task',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  present: 'Present',
  ask_user_question: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
  run_code: 'RunCode',
  workflow: 'Workflow',
});

/**
 * @param {string} dshToolName
 * @returns {string}
 */
export function toClaudeToolName(dshToolName) {
  const name = String(dshToolName ?? '');
  return CLAUDE_TOOL_NAMES[name] ?? name;
}

function isRegexToken(token) {
  return /[\\^$.*+?()[\]{}|]/.test(token);
}

/**
 * Match one ECC matcher group against the Claude-style tool name.
 *
 * @param {string|undefined} matcher
 * @param {string} toolName
 * @returns {boolean}
 */
export function matchesToolMatcher(matcher, toolName) {
  if (matcher === undefined || matcher === null || matcher === '') return true;
  const text = String(matcher).trim();
  if (text === '' || text === '*' || text === '.*') return true;
  const name = String(toolName ?? '');

  for (const rawToken of text.split('|')) {
    const token = rawToken.trim();
    if (token === '') continue;
    if (token === '*' || token === '.*') return true;
    if (isRegexToken(token)) {
      try {
        if (new RegExp(token).test(name)) return true;
      } catch {
        // A malformed user regex falls through to the exact comparison.
      }
    }
    if (token.toLowerCase() === name.toLowerCase()) return true;
  }

  return false;
}

function normalizeHook(rawHook, event, index) {
  if (!rawHook || typeof rawHook !== 'object' || Array.isArray(rawHook)) return null;
  if (rawHook.type !== undefined && rawHook.type !== 'command') return null;
  if (typeof rawHook.command !== 'string' || rawHook.command.trim() === '') return null;

  const timeout = Number.isFinite(rawHook.timeout) && rawHook.timeout > 0
    ? rawHook.timeout
    : undefined;

  return {
    id: `${event}:${index}`,
    command: rawHook.command,
    timeout,
    async: rawHook.async === true,
  };
}

/**
 * Parse `hooks/hooks.json`.
 *
 * @param {string} hooksPath
 * @returns {{ events: Record<string, object[]>, warnings: string[], commandCount: number }}
 */
export function loadHooksConfig(hooksPath) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  } catch (error) {
    return {
      events: {},
      warnings: [`cannot read hooks config ${hooksPath}: ${error.message}`],
      commandCount: 0,
    };
  }

  const source = document && typeof document === 'object' && !Array.isArray(document)
    ? document.hooks
    : undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {
      events: {},
      warnings: [`${hooksPath} has no "hooks" object`],
      commandCount: 0,
    };
  }

  const events = {};
  const warnings = [];
  let commandCount = 0;

  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) {
      warnings.push(`hook event "${event}" is not an array; ignored`);
      continue;
    }

    const normalizedGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      const hooks = [];
      const rawHooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (const rawHook of rawHooks) {
        const hook = normalizeHook(rawHook, event, hooks.length);
        if (hook === null) {
          warnings.push(`unsupported hook on ${event}; ignored`);
          continue;
        }
        hooks.push(hook);
      }
      if (hooks.length === 0) continue;
      normalizedGroups.push({
        matcher: group.matcher === undefined ? undefined : String(group.matcher),
        hooks,
      });
      commandCount += hooks.length;
    }

    if (normalizedGroups.length > 0) events[event] = normalizedGroups;
  }

  const unsupported = Object.keys(events).filter(event => !SUPPORTED_HOOK_EVENTS.includes(event));
  for (const event of unsupported) {
    warnings.push(`hook event "${event}" has no DeepSeek Harness bridge and will not run`);
  }

  return { events, warnings, commandCount };
}

/**
 * Select the hook commands that apply to one event and (optionally) tool.
 *
 * @param {{ events: Record<string, object[]> }} catalog
 * @param {string} event
 * @param {string} [toolName] Claude-style tool name
 * @returns {object[]}
 */
export function selectHooks(catalog, event, toolName) {
  const groups = catalog.events[event] ?? [];
  const hooks = [];
  for (const group of groups) {
    if (toolName !== undefined && !matchesToolMatcher(group.matcher, toolName)) continue;
    hooks.push(...group.hooks);
  }
  return hooks;
}

/**
 * Parse one ECC command string into an executable form.
 *
 * @param {string} command
 * @returns {{ kind: 'node', args: string[] } | { kind: 'shell', command: string }}
 */
export function parseHookCommand(command) {
  const text = String(command ?? '').trim();
  const words = splitShellWords(text);
  const executable = words[0] === undefined ? '' : words[0].toLowerCase();
  const isNode = executable === 'node' || executable === 'node.exe';

  if (isNode && words.length >= 2) {
    if (words[1] === '-e' && words.length >= 3) {
      return { kind: 'node', args: words.slice(1) };
    }
    return { kind: 'node', args: words.slice(1) };
  }

  return { kind: 'shell', command: text };
}

/**
 * Count command hooks per event for diagnostics.
 *
 * @param {{ events: Record<string, object[]> }} catalog
 * @returns {Record<string, number>}
 */
export function countHooksByEvent(catalog) {
  const counts = {};
  for (const [event, groups] of Object.entries(catalog.events)) {
    counts[event] = groups.reduce((total, group) => total + group.hooks.length, 0);
  }
  return counts;
}
