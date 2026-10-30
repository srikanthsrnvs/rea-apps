import fs from 'node:fs';
import { backend } from './backend.mjs';
import { scenarios } from './scenarios.mjs';
import { eatsToolManifest, legacyEatsTools } from '../../src/eats/tools.mjs';
import { runEatsTool } from '../../src/eats/tool-dispatch.mjs';
export default function (pi) {
  const scenario = scenarios[process.env.EATS_EVAL_CASE];
  if (!scenario) throw new Error('Select EATS_EVAL_CASE');
  const f = backend(scenario),
    legacy = process.env.EATS_EVAL_PROFILE === 'legacy';
  const tools = legacy ? legacyEatsTools : eatsToolManifest.tools;
  const record = (value) => {
    if (process.env.EATS_EVAL_TRACE)
      fs.appendFileSync(
        process.env.EATS_EVAL_TRACE,
        JSON.stringify(value) + '\n',
        { mode: 0o600 },
      );
  };
  const output = () => {
    if (process.env.EATS_EVAL_STATE)
      fs.writeFileSync(
        process.env.EATS_EVAL_STATE,
        JSON.stringify(
          {
            drafts: f.drafts,
            writes: f.writeCount,
            calls: f.calls,
            records: [...f.records],
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
  };
  for (const tool of tools)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args) {
        let result;
        if (
          tool.name === 'eats_order' &&
          !['status', 'history'].includes(args.action ?? 'status')
        )
          result = {
            error: {
              code: 'EVALUATION_ORDER_DISABLED',
              message:
                'Orders and cancellations are disabled in this evaluation.',
            },
          };
        else if (args.requestFile !== undefined)
          result = {
            error: {
              code: 'EVALUATION_FILE_UNAVAILABLE',
              message:
                'No request file was created in this tool session. There is no file-writing tool. No mutation was submitted.',
            },
          };
        else
          try {
            result = await runEatsTool(tool.name, args, {
              execute: f.execute,
              compact: !legacy,
            });
          } catch (error) {
            result = {
              error: {
                code: error.code ?? 'TOOL_ERROR',
                message: error.message,
                ...(error.operationId
                  ? { operationId: error.operationId }
                  : {}),
              },
              ...(error.operationId ? { operationId: error.operationId } : {}),
            };
          }
        record({ name: tool.name, args, result });
        output();
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
  pi.on('agent_end', output);
}
