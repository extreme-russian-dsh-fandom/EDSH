/**
 * Asynchronous ECC hook execution.
 *
 * Hooks run inside the Harness Host process, so the adapter must never block
 * the event loop with a synchronous child process. Commands that start with
 * `node` are spawned directly; only third-party shell hooks fall back to the
 * platform shell.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseHookCommand } from './hook-catalog.js';
import { mergeHookResults } from './hook-protocol.js';

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;

function appendLimited(current, chunk, limit) {
  if (current.length >= limit) return current;
  const next = current + chunk.toString('utf8');
  return next.length <= limit ? next : next.slice(0, limit);
}

/**
 * Execute one command and capture bounded output.
 *
 * @param {{ kind: 'node', args: string[] } | { kind: 'shell', command: string }} parsed
 * @param {{
 *   input: string,
 *   env?: Record<string, string|undefined>,
 *   cwd?: string,
 *   timeoutMs: number,
 *   maxOutputBytes: number,
 * }} options
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null, signal: string|null, error?: Error, timedOut: boolean }>}
 */
export function runHookCommand(parsed, options) {
  const maxOutputBytes = options.maxOutputBytes ?? 2097152;

  return new Promise(resolve => {
    let child;
    try {
      if (parsed.kind === 'node') {
        child = spawn(process.execPath, parsed.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        child = spawn(parsed.command, {
          cwd: options.cwd,
          env: options.env,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      }
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        error,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, error, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited; the close handler settles.
      }
    }, Math.max(1, options.timeoutMs));

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, chunk, maxOutputBytes);
    });
    child.on('error', error => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal, undefined));

    try {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input, 'utf8');
    } catch {
      // A command that never reads stdin can close the pipe early; its exit
      // status still decides the hook outcome.
    }
  });
}

/**
 * Serialize hook input and keep it below the ECC stdin safety limit.
 *
 * @param {Record<string, unknown>} input
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function serializeHookInput(input, maxBytes = 1048576) {
  const initial = JSON.stringify(input);
  if (Buffer.byteLength(initial, 'utf8') <= maxBytes) {
    return { text: initial, truncated: false };
  }

  const reduced = {
    ...input,
    tool_response: {
      content: '[ECC] tool response omitted: it exceeded the hook input budget.',
      output: '',
      isError: input.tool_response?.isError === true,
      truncated: true,
    },
  };
  const second = JSON.stringify(reduced);
  if (Buffer.byteLength(second, 'utf8') <= maxBytes) {
    return { text: second, truncated: true };
  }

  const minimal = {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    hook_event_name: input.hook_event_name,
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    tool_input: { note: '[ECC] tool input omitted: it exceeded the hook input budget.' },
    truncated: true,
  };
  return { text: JSON.stringify(minimal), truncated: true };
}

/**
 * Resolve the timeout for one hook command.
 *
 * @param {object} hook
 * @param {{ timeoutSeconds?: number, maxTimeoutSeconds?: number }} config
 * @returns {number}
 */
export function resolveHookTimeoutMs(hook, config = {}) {
  const configured = Number.isInteger(config.timeoutSeconds) && config.timeoutSeconds > 0
    ? config.timeoutSeconds
    : undefined;
  const own = Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout : undefined;
  const seconds = configured ?? own ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
  const max = Number.isInteger(config.maxTimeoutSeconds) && config.maxTimeoutSeconds > 0
    ? config.maxTimeoutSeconds
    : 600;
  return Math.min(seconds, max) * 1000;
}

/**
 * Run every applicable hook for one event.
 *
 * @param {object[]} hooks
 * @param {{
 *   event: string,
 *   input: Record<string, unknown>,
 *   env: Record<string, string|undefined>,
 *   cwd: string,
 *   config: object,
 *   onWarning?: (message: string) => void,
 * }} options
 * @returns {Promise<{ results: object[], merged: object }>}
 */
export async function runHooks(hooks, options) {
  const { text, truncated } = serializeHookInput(options.input, options.config.maxInputBytes);
  const env = {
    ...options.env,
    CLAUDE_PROJECT_DIR: options.cwd,
    ECC_HOOK_INPUT_TRUNCATED_UPSTREAM: truncated ? '1' : '0',
    ECC_HOOK_INPUT_MAX_BYTES: String(options.config.maxInputBytes),
  };

  const results = [];
  const pending = [];

  for (const hook of hooks) {
    const parsed = parseHookCommand(hook.command);
    const timeoutMs = resolveHookTimeoutMs(hook, options.config);
    const run = runHookCommand(parsed, {
      input: text,
      env,
      cwd: options.cwd,
      timeoutMs,
      maxOutputBytes: options.config.maxOutputBytes,
    });

    if (hook.async && options.config.asyncHooks) {
      pending.push(run.then(result => {
        if (result.error || result.timedOut || (Number.isInteger(result.code) && result.code !== 0)) {
          options.onWarning?.(`async hook ${hook.id} finished with ${result.error?.message ?? result.code ?? 'a signal'}`);
        }
      }));
      continue;
    }

    const result = await run;
    if (result.timedOut) {
      options.onWarning?.(`hook ${hook.id} timed out after ${timeoutMs}ms`);
    } else if (result.error) {
      options.onWarning?.(`hook ${hook.id} failed: ${result.error.message}`);
    } else if (result.signal) {
      options.onWarning?.(`hook ${hook.id} terminated by signal ${result.signal}`);
    }
    results.push({ hook, ...result });
  }

  if (pending.length > 0) {
    void Promise.allSettled(pending);
  }

  return {
    results,
    merged: mergeHookResults(results, options.event),
  };
}

/**
 * @param {string} eccRoot
 * @param {string} cwd
 * @param {{ profile?: string, sessionId?: string }} extra
 * @returns {Record<string, string|undefined>}
 */
export function buildHookEnvironment(eccRoot, cwd, extra = {}) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: eccRoot,
    ECC_PLUGIN_ROOT: eccRoot,
    CLAUDE_PROJECT_DIR: cwd,
    ...(extra.profile ? { ECC_HOOK_PROFILE: extra.profile } : {}),
    ...(extra.sessionId ? { ECC_SESSION_ID: extra.sessionId } : {}),
  };
}

/**
 * Resolve a project-relative path for hook cwd values.
 *
 * @param {string|undefined} value
 * @param {string} fallback
 * @returns {string}
 */
export function resolveHookCwd(value, fallback) {
  return path.resolve(value && value.trim() !== '' ? value : fallback);
}
