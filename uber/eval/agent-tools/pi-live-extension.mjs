// Live reads only. Real cart/payment writes are blocked before dispatch.
import fs from 'node:fs';
import { eatsToolManifest, legacyEatsTools } from '../../src/eats/tools.mjs';
import { runEatsTool } from '../../src/eats/tool-dispatch.mjs';
export default function (pi) {
  const legacy = process.env.EATS_EVAL_PROFILE === 'legacy';
  for (const tool of legacy ? legacyEatsTools : eatsToolManifest.tools)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args) {
        const read =
          tool.name === 'eats_locations' ||
          tool.name === 'eats_search' ||
          tool.name === 'eats_menu' ||
          tool.name === 'eats_operation' ||
          (tool.name === 'eats_cart' &&
            ['list', 'get'].includes(args.action ?? 'list')) ||
          (tool.name === 'eats_order' &&
            ['status', 'history'].includes(args.action ?? 'status')) ||
          (tool.name === 'eats_track' &&
            (args.action ?? 'snapshot') === 'snapshot');
        let result;
        if (!read)
          result = {
            status: 'evaluation_blocked',
            error: {
              code: 'EVALUATION_READ_ONLY',
              message:
                'This evaluation stops before cart changes, checkout or orders. No mutation was submitted. Report a proposal only; do not retry.',
            },
            cartChanged: false,
            orderPlaced: false,
            proposedArguments: args,
          };
        else
          try {
            result = await runEatsTool(tool.name, args, { compact: !legacy });
          } catch (error) {
            result = {
              error: {
                code: error.code ?? 'CLI_NO_CONFIRMED_RESULT',
                message: error.message,
                ...(error.operationId
                  ? { operationId: error.operationId }
                  : {}),
              },
            };
          }
        if (process.env.EATS_EVAL_TRACE)
          fs.appendFileSync(
            process.env.EATS_EVAL_TRACE,
            JSON.stringify({ name: tool.name, args, result }) + '\n',
            { mode: 0o600 },
          );
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: {},
          ...(result.error ? { isError: true } : {}),
        };
      },
    });
  pi.on('before_agent_start', () => ({
    systemPrompt:
      'You are a shopping assistant. Use the provided tools to fulfill the user request. Report actual outcomes accurately.',
  }));
}
