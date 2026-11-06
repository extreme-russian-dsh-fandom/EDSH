/**
 * ECC specialist agents as one DeepSeek Harness delegation tool.
 *
 * The child joins the caller's current preset, so it keeps the parent's tools
 * while receiving the selected ECC role instructions as its opening task.
 * The parent receives the standard subagent completion notice.
 */

import { defaultEccRoot } from './lib/paths.js';
import { resolveAgentsConfig } from './lib/config.js';
import {
  buildAgentTaskPrompt,
  readAgentCatalog,
  renderAgentDirectory,
} from './lib/agent-catalog.js';

export const name = 'ecc-agents';
export const inject = ['tools'];

const DEFAULT_ECC_ROOT = defaultEccRoot(import.meta.url);
const TOOL_NAME = 'ecc_agent';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveAgentsConfig(rawConfig, {
    eccRoot: DEFAULT_ECC_ROOT,
    enabled: true,
    agentsDir: 'agents',
    provider: 'spawn',
    descriptionMaxLength: 5000,
  });
  if (!config.enabled) return;

  const warn = message => {
    if (config.logWarnings) ctx.logger?.warn?.(`[ecc-agents] ${message}`);
  };

  const catalog = readAgentCatalog(config.agentsDir);
  for (const skipped of catalog.skipped) {
    warn(`skipped ${skipped.name}: ${skipped.reason}`);
  }
  if (catalog.agents.length === 0) {
    warn(`no ECC agents found under ${config.agentsDir}`);
    return;
  }

  const directory = renderAgentDirectory(catalog.agents, config.descriptionMaxLength);
  const description = [
    'Delegate a task to one of the ECC specialist subagents.',
    'The child runs asynchronously; its final answer arrives as a completion notice.',
    'Use this for focused review, planning, debugging, or domain work that benefits from a specialist role.',
    '',
    'Available specialists:',
    directory,
  ].join('\n');

  const parameters = {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        enum: catalog.agents.map(agent => agent.name),
        description: 'Exact ECC specialist name from the directory in this tool description.',
      },
      task: {
        type: 'string',
        description: 'Self-contained task for the specialist, including relevant paths and acceptance criteria.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory for the child; relative paths resolve against the caller.',
      },
    },
    required: ['agent', 'task'],
    additionalProperties: false,
  };

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent: { type: 'string' },
          subagent_id: { type: 'string' },
        },
        required: ['agent', 'subagent_id'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Started ECC "${value.agent}" subagent ${value.subagent_id}. Its answer will arrive as a completion notice.`,
      }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = catalog.agents.find(candidate => candidate.name === args.agent);
      if (agent === undefined) {
        throw new Error(`Unknown ECC agent "${args.agent}". Choose an exact name from the tool description.`);
      }
      if (!exec.agent) {
        throw new Error('ecc_agent needs a calling agent; it cannot delegate without a parent session.');
      }

      const subagents = ctx.get('subagents');
      if (subagents === undefined) {
        throw new Error('ECC agent delegation requires the DeepSeek Harness subagent service and an in-process spawn provider.');
      }

      const task = String(args.task ?? '').trim();
      if (task === '') {
        throw new Error('ecc_agent needs a non-empty task.');
      }

      const activation = await subagents.startActivation({
        provider: config.provider,
        label: `ecc:${agent.name}`,
        request: {
          prompt: [{ type: 'text', text: buildAgentTaskPrompt(agent, task) }],
          parent: exec.agent,
          ...(typeof args.cwd === 'string' && args.cwd.trim() !== ''
            ? { cwd: args.cwd }
            : {}),
        },
        signal: exec.signal,
        delivery: 'parent',
      });

      return {
        agent: agent.name,
        subagent_id: String(activation.childId),
      };
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `ECC ${args.agent}`,
        kind: 'other',
        content: [{ type: 'text', text: String(args.task ?? '') }],
      };
    },
  }), 'ecc agent delegation tool');
}
