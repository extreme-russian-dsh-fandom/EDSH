/**
 * ECC command hooks on DeepSeek Harness events.
 *
 * The bridge keeps ECC's canonical `hooks/hooks.json` and runs its commands
 * unchanged. It maps DSH agent and tool events onto Claude Code hook events,
 * builds the documented stdin JSON, and translates the structured output back
 * into DSH pre-step, pre-tool, post-tool, and turn-stopping decisions.
 *
 * Unsupported: PreCompact has no public DSH event. `/ecc-doctor` reports it.
 */

import { defaultEccRoot } from './lib/paths.js';
import { resolveHooksConfig } from './lib/config.js';
import {
  loadHooksConfig,
  selectHooks,
  toClaudeToolName,
} from './lib/hook-catalog.js';
import { buildHookInput, extractPromptText } from './lib/hook-protocol.js';
import { buildHookEnvironment, runHooks } from './lib/hook-runner.js';

export const name = 'ecc-hooks';
export const inject = [];

const DEFAULT_ECC_ROOT = defaultEccRoot(import.meta.url);
const MAX_REMEMBERED_PROMPTS = 2000;

function sessionIdOf(agent) {
  return String(agent?.id ?? agent?.session?.id ?? '');
}

function formatContext(text) {
  const body = String(text).trim().replace(/<\/system-reminder>/gi, '<\\/system-reminder>');
  return [
    '<system-reminder>',
    'ECC hook context:',
    '',
    body,
    '</system-reminder>',
  ].join('\n');
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveHooksConfig(rawConfig, {
    eccRoot: DEFAULT_ECC_ROOT,
    enabled: true,
    hooksPath: 'hooks/hooks.json',
    profile: '',
    timeoutSeconds: 0,
    maxTimeoutSeconds: 600,
    asyncHooks: true,
    injectContext: true,
    maxStopBlocks: 3,
    stopBlockingTimeoutSeconds: 30,
    maxInputBytes: 1048576,
    maxOutputBytes: 2097152,
  });
  if (!config.enabled) return;

  const catalog = loadHooksConfig(config.hooksPath);
  const warned = new Set();
  const warn = message => {
    if (!config.logWarnings || warned.has(message)) return;
    warned.add(message);
    ctx.logger?.warn?.(`[ecc-hooks] ${message}`);
  };
  for (const warning of catalog.warnings) warn(warning);

  if (catalog.commandCount === 0) {
    warn(`no hook commands found in ${config.hooksPath}`);
    return;
  }

  const workingDirectory = () => {
    const service = ctx.get('workingDirectory');
    return service && typeof service.get === 'function' ? service : undefined;
  };

  const cwdOf = agent => {
    try {
      const service = workingDirectory();
      const value = service?.get(agent?.session);
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // Fall back to the Host process directory when the service is absent.
    }
    return process.cwd();
  };

  const injectContext = (agent, text) => {
    if (!config.injectContext || !text) return;
    if (typeof agent?.inject !== 'function') return;
    try {
      agent.inject({
        content: [{ type: 'text', text: formatContext(text) }],
        source: { kind: 'ecc-hook' },
      });
    } catch (error) {
      warn(`context injection failed: ${error.message}`);
    }
  };

  const steer = (agent, text) => {
    if (!text || typeof agent?.steer !== 'function') return false;
    try {
      agent.steer({
        content: [{ type: 'text', text }],
        source: { kind: 'ecc-hook' },
      });
      return true;
    } catch (error) {
      warn(`steering failed: ${error.message}`);
      return false;
    }
  };

  const runEvent = async (event, context, options = {}) => {
    const claudeTool = context.toolName === undefined
      ? undefined
      : toClaudeToolName(context.toolName);
    const hooks = selectHooks(catalog, event, claudeTool);
    if (hooks.length === 0) return null;

    const input = buildHookInput(context);
    const env = buildHookEnvironment(config.eccRoot, context.cwd, {
      profile: config.profile,
      sessionId: context.sessionId,
    });
    const runConfig = options.config
      ? { ...config, ...options.config }
      : config;

    let blockingHooks = hooks;
    if (options.splitSlowHooks) {
      blockingHooks = hooks.filter(hook => (
        !hook.async
        && (hook.timeout === undefined || hook.timeout <= config.stopBlockingTimeoutSeconds)
      ));
      const background = hooks.filter(hook => !blockingHooks.includes(hook));
      if (background.length > 0) {
        void runHooks(background.map(hook => ({ ...hook, async: true })), {
          event,
          input,
          env,
          cwd: context.cwd,
          config: runConfig,
          onWarning: warn,
        }).catch(error => warn(`${event} background hooks failed: ${error.message}`));
      }
    }

    if (blockingHooks.length === 0) return null;

    try {
      const { merged } = await runHooks(blockingHooks, {
        event,
        input,
        env,
        cwd: context.cwd,
        config: runConfig,
        onWarning: warn,
      });
      for (const warning of merged.warnings) warn(warning);
      return merged;
    } catch (error) {
      warn(`${event} bridge failed: ${error.message}`);
      return null;
    }
  };

  const startedSessions = new Set();
  const processedPrompts = new Set();
  const stopState = new Map();

  ctx.effect(() => {
    const disposers = [];

    disposers.push(ctx.on('agent/created', async ({ agent, source }) => {
      const sessionId = sessionIdOf(agent);
      if (sessionId === '' || startedSessions.has(sessionId)) return;
      startedSessions.add(sessionId);

      const merged = await runEvent('SessionStart', {
        event: 'SessionStart',
        sessionId,
        cwd: cwdOf(agent),
        source: typeof source === 'string' ? source : (source?.kind ?? 'startup'),
        agentId: sessionId,
      });
      if (merged?.additionalContext) injectContext(agent, merged.additionalContext);
    }));

    disposers.push(ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      if (signal?.aborted) return next();

      const fresh = Array.isArray(messages)
        ? messages.filter(message => {
            const id = String(message?.id ?? '');
            if (id === '' || processedPrompts.has(id)) return false;
            processedPrompts.add(id);
            return true;
          })
        : [];

      if (fresh.length === 0) return next();
      if (processedPrompts.size > MAX_REMEMBERED_PROMPTS) {
        for (const id of processedPrompts) {
          processedPrompts.delete(id);
          if (processedPrompts.size <= MAX_REMEMBERED_PROMPTS / 2) break;
        }
      }

      const prompt = extractPromptText(fresh);
      if (prompt === '') return next();

      const merged = await runEvent('UserPromptSubmit', {
        event: 'UserPromptSubmit',
        sessionId: sessionIdOf(agent),
        cwd: cwdOf(agent),
        prompt,
        agentId: sessionIdOf(agent),
      });
      if (merged?.additionalContext) injectContext(agent, merged.additionalContext);
      return next();
    }));

    disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      if (!exec?.agent) return next();
      const merged = await runEvent('PreToolUse', {
        event: 'PreToolUse',
        sessionId: sessionIdOf(exec.agent),
        cwd: cwdOf(exec.agent),
        toolName: exec.name,
        toolArguments: exec.arguments,
        toolCallId: exec.callId,
        agentId: sessionIdOf(exec.agent),
      });

      if (merged?.permissionDecision === 'deny') {
        return { kind: 'deny', reason: merged.reason || 'Blocked by an ECC hook.' };
      }
      if (merged?.permissionDecision === 'ask') {
        return { kind: 'ask', reason: merged.reason || 'An ECC hook requires confirmation.' };
      }
      if (merged?.additionalContext) injectContext(exec.agent, merged.additionalContext);
      return next();
    }));

    disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
      if (!exec?.agent) return next();
      const event = result?.isError === true ? 'PostToolUseFailure' : 'PostToolUse';
      const merged = await runEvent(event, {
        event,
        sessionId: sessionIdOf(exec.agent),
        cwd: cwdOf(exec.agent),
        toolName: exec.name,
        toolArguments: exec.arguments,
        toolResult: result,
        toolCallId: exec.callId,
        agentId: sessionIdOf(exec.agent),
      });

      if (merged?.blocked && merged.reason) {
        return {
          kind: 'block',
          feedback: [{ type: 'text', text: merged.reason }],
        };
      }
      if (merged?.additionalContext) injectContext(exec.agent, merged.additionalContext);
      return next();
    }));

    disposers.push(ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      const sessionId = sessionIdOf(agent);
      const state = stopState.get(sessionId);
      const count = state !== undefined && state.turn === turn ? state.blocks : 0;

      const merged = await runEvent('Stop', {
        event: 'Stop',
        sessionId,
        cwd: cwdOf(agent),
        stopHookActive: count > 0,
        agentId: sessionId,
      }, {
        splitSlowHooks: true,
      });

      if (!merged?.blocked || merged.reason === undefined) return;
      if (count >= config.maxStopBlocks) {
        warn(`Stop hook asked to continue after ${count} blocks; closing the turn`);
        return;
      }

      if (steer(agent, merged.reason)) {
        stopState.set(sessionId, { turn, blocks: count + 1 });
      }
    }));

    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      const sessionId = sessionIdOf(agent);
      stopState.delete(sessionId);
      startedSessions.delete(sessionId);

      void runEvent('SessionEnd', {
        event: 'SessionEnd',
        sessionId,
        cwd: cwdOf(agent),
        source: 'other',
        agentId: sessionId,
      });
    }));

    disposers.push(ctx.on('subagent/start', info => {
      const childId = String(info?.childId ?? info?.id ?? '');
      void runEvent('SubagentStart', {
        event: 'SubagentStart',
        sessionId: childId,
        cwd: String(info?.cwd ?? process.cwd()),
        agentId: childId,
      });
    }));

    disposers.push(ctx.on('subagent/end', info => {
      const childId = String(info?.childId ?? info?.id ?? '');
      void runEvent('SubagentStop', {
        event: 'SubagentStop',
        sessionId: childId,
        cwd: String(info?.cwd ?? process.cwd()),
        agentId: childId,
      });
    }));

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // Best-effort teardown during reloads.
        }
      }
    };
  }, 'ecc hook bridge');
}
