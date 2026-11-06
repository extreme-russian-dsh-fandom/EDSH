/**
 * Claude Code hook wire protocol <-> DeepSeek Harness event data.
 *
 * ECC hooks are ordinary processors over Claude's documented hook JSON:
 * stdin carries the event, stdout carries a structured decision, and exit
 * code 2 blocks. This module builds that JSON from DSH values and merges the
 * hook outputs back into one DSH decision.
 */

import { toClaudeToolName } from './hook-catalog.js';

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

/**
 * Convert a DSH tool argument object into the Claude tool-input shape ECC
 * hooks already understand.
 *
 * @param {string} dshToolName
 * @param {unknown} args
 * @returns {Record<string, unknown>}
 */
export function mapToolInput(dshToolName, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const name = String(dshToolName ?? '');

  if (name === 'bash' || name === 'pwsh' || name === 'powershell') {
    return {
      command: String(input.command ?? ''),
      description: input.description,
      timeout: input.timeout,
      run_in_background: input.run_in_background,
    };
  }

  if (name === 'write') {
    return {
      file_path: input.path ?? input.file_path,
      content: input.content,
    };
  }

  if (name === 'edit') {
    return {
      file_path: input.path ?? input.file_path,
      old_string: input.old_string,
      new_string: input.new_string,
      replace_all: input.replace_all,
    };
  }

  if (name === 'read') {
    return {
      file_path: input.path ?? input.file_path,
      offset: input.offset,
      limit: input.limit,
    };
  }

  if (name === 'grep') {
    return {
      pattern: input.pattern,
      path: input.path,
      glob: input.include,
      output_mode: 'content',
    };
  }

  if (name === 'glob') {
    return {
      pattern: input.pattern,
      path: input.path,
    };
  }

  if (name === 'skill') {
    return {
      skill: input.name,
      name: input.name,
    };
  }

  if (name === 'subagent' || name === 'subagent_fork' || name === 'task') {
    return {
      description: input.description,
      prompt: input.prompt ?? input.task,
      subagent_type: input.agent ?? input.agent_preset,
    };
  }

  if (name === 'web_search') {
    const queries = Array.isArray(input.queries) ? input.queries : [input.query];
    return { query: queries.filter(Boolean).join(' ') };
  }

  if (name === 'web_fetch') {
    return { url: input.url, prompt: input.prompt };
  }

  if (name === 'todo_write') {
    return { todos: input.todos };
  }

  if (name === 'ask_user_question') {
    return { questions: input.questions };
  }

  if (name === 'present') {
    return { files: input.files };
  }

  return { ...input };
}

/**
 * Convert a DSH tool result into a Claude-style `tool_response`.
 *
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
export function mapToolResponse(result) {
  const value = result && typeof result === 'object' ? result : {};
  const content = Array.isArray(value.content) ? value.content : [];
  const text = textFromContent(content);
  const isError = value.isError === true;

  return {
    content: text,
    output: text,
    isError,
    stdout: isError ? '' : text,
    stderr: isError ? (value.error?.message ?? text) : '',
    error: value.error,
  };
}

/**
 * Build the stdin document for one ECC hook command.
 *
 * @param {{
 *   event: string,
 *   sessionId?: string,
 *   cwd?: string,
 *   toolName?: string,
 *   toolArguments?: unknown,
 *   toolResult?: unknown,
 *   toolCallId?: string,
 *   prompt?: string,
 *   source?: string,
 *   agentId?: string,
 *   stopHookActive?: boolean,
 *   permissionMode?: string,
 * }} context
 * @returns {Record<string, unknown>}
 */
export function buildHookInput(context) {
  const input = {
    session_id: context.sessionId ?? '',
    transcript_path: '',
    cwd: context.cwd ?? process.cwd(),
    hook_event_name: context.event,
    permission_mode: context.permissionMode ?? 'default',
  };

  if (context.toolName !== undefined) {
    const claudeName = toClaudeToolName(context.toolName);
    input.tool_name = claudeName;
    input.tool = claudeName;
    input.tool_input = mapToolInput(context.toolName, context.toolArguments);
    input.tool_use_id = context.toolCallId ?? '';
  }

  if (context.toolResult !== undefined) {
    input.tool_response = mapToolResponse(context.toolResult);
  }

  if (context.prompt !== undefined) {
    input.prompt = String(context.prompt);
  }

  if (context.source !== undefined) {
    input.source = context.source;
  }

  if (context.agentId !== undefined) {
    input.agent_id = context.agentId;
  }

  if (context.stopHookActive !== undefined) {
    input.stop_hook_active = context.stopHookActive === true;
  }

  return input;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Parse one command's stdout into a normalized hook output.
 *
 * @param {string} stdout
 * @param {string} event
 * @returns {{ permissionDecision?: string, reason?: string, additionalContext?: string, blocked?: boolean }}
 */
export function parseHookOutput(stdout, event) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '').trim();
  if (text === '') return {};

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      return { additionalContext: text };
    }
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      return { additionalContext: text };
    }
    return {};
  }

  const specific = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === 'object'
    ? parsed.hookSpecificOutput
    : undefined;

  const permissionDecision = asString(specific?.permissionDecision ?? parsed.permissionDecision);
  const reason = asString(specific?.permissionDecisionReason ?? parsed.reason);
  const additionalContext = asString(specific?.additionalContext ?? parsed.additionalContext);
  const decision = asString(specific?.decision ?? parsed.decision);
  const blocked = decision === 'block' || parsed.continue === false;

  return {
    permissionDecision: permissionDecision === '' ? undefined : permissionDecision,
    reason: reason === '' ? undefined : reason,
    additionalContext: additionalContext === '' ? undefined : additionalContext,
    blocked: blocked || undefined,
  };
}

function appendReason(current, next) {
  if (!next) return current;
  return current === '' ? next : `${current}\n\n${next}`;
}

function appendContext(current, next) {
  if (!next) return current;
  return current === '' ? next : `${current}\n\n${next}`;
}

/**
 * Merge every hook process result for one event.
 *
 * @param {Array<{ hook: object, stdout?: string, stderr?: string, code?: number, signal?: string, error?: Error, timedOut?: boolean }>} results
 * @param {string} event
 * @returns {{
 *   event: string,
 *   permissionDecision?: 'allow'|'ask'|'deny',
 *   reason?: string,
 *   additionalContext?: string,
 *   blocked: boolean,
 *   warnings: string[],
 * }}
 */
export function mergeHookResults(results, event) {
  let permissionDecision = 'allow';
  let reason = '';
  let additionalContext = '';
  const warnings = [];

  for (const result of results) {
    const hookId = result.hook?.id ?? event;
    if (result.timedOut) {
      warnings.push(`${hookId} timed out`);
      continue;
    }
    if (result.error) {
      warnings.push(`${hookId} failed: ${result.error.message}`);
      continue;
    }
    if (result.signal) {
      warnings.push(`${hookId} terminated by signal ${result.signal}`);
      continue;
    }

    if (result.code === 2) {
      const stderr = String(result.stderr ?? '').trim();
      warnings.push(`${hookId} blocked the call with exit code 2`);
      if (event === 'PreToolUse') {
        permissionDecision = 'deny';
      }
      reason = appendReason(reason, stderr || `${hookId} blocked this action.`);
      continue;
    }

    if (Number.isInteger(result.code) && result.code !== 0) {
      warnings.push(`${hookId} exited with code ${result.code}`);
    }

    const output = parseHookOutput(result.stdout, event);
    if (output.additionalContext) {
      additionalContext = appendContext(additionalContext, output.additionalContext);
    }
    if (output.blocked) {
      reason = appendReason(reason, output.reason ?? `${hookId} blocked this action.`);
    } else if (output.reason) {
      reason = appendReason(reason, output.reason);
    }
    if (output.permissionDecision === 'deny') {
      permissionDecision = 'deny';
    } else if (output.permissionDecision === 'ask' && permissionDecision !== 'deny') {
      permissionDecision = 'ask';
    }
  }

  return {
    event,
    permissionDecision,
    reason: reason === '' ? undefined : reason,
    additionalContext: additionalContext === '' ? undefined : additionalContext,
    blocked: reason !== '' && (event === 'Stop' || event === 'PostToolUse' || event === 'PostToolUseFailure'),
    warnings,
  };
}

/**
 * Extract the text of claimed user messages for UserPromptSubmit hooks.
 *
 * @param {Array<{ content?: unknown }>} messages
 * @returns {string}
 */
export function extractPromptText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map(message => textFromContent(message?.content))
    .filter(Boolean)
    .join('\n\n');
}
