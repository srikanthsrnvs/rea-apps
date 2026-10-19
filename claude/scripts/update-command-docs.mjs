import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {toolDefinitions} from '../src/cli.mjs';

const destination=fileURLToPath(new URL('../docs/commands.md',import.meta.url));
const escape=value=>value.replaceAll('|','\\|').replaceAll('\n',' ');
const rows=toolDefinitions.map(tool=>{
 const options=Object.entries(tool.inputSchema.properties).map(([name,schema])=>{
  const argument=schema.type==='boolean'?'':schema.format==='uuid'?' UUID':' VALUE';
  const flag=`\`--${name}${argument}\``;
  return tool.inputSchema.required.includes(name)?`**${flag}**`:flag;
 }).join(', ')||'None';
 return `| \`${tool.command}\` | ${escape(tool.description)} | ${options} |`;
});
const document=`# Command reference

Generated from the CLI's tool definitions. Run commands with the
\`claude-chat\` prefix. **Bold options are required.** All commands accept
\`--pretty\` for indented JSON. \`claude-chat tools\` returns the machine-readable
schemas; \`--help\` returns the same command inventory.

| Command | Purpose | Options |
| --- | --- | --- |
${rows.join('\n')}

## Argument rules

- An unauthenticated \`login\` needs \`--email\`. With a saved session, it returns
  that session's summary unless \`--replace\` is supplied.
- First-time \`auth complete\` needs exactly one email code or magic-link URL.
  Use either the value option or its corresponding \`-file\` option. Later
  recovery from \`validation_pending\` needs only \`--login-id\`.
- \`chat new\` and \`chat reply\` need exactly one of \`--prompt\` or
  \`--prompt-file\`. Prompts are limited to 1 MiB.
- \`--limit\` accepts an integer from 1 to 100. A manual continuation uses
  \`--cursor\` and \`--section\` from \`pagination.continuations[]\`.
- \`--timezone\` is an IANA timezone. When omitted, the host's timezone is used.
  \`--model\` is optional; omission preserves the account/server default.
- \`--parent-message-id\` deliberately selects a reply branch. Otherwise the
  CLI reads the current server leaf. \`--name\` and \`--temporary\` apply only
  when creating a chat.
- Duplicate options, unknown options, and options from another command fail
  before command execution.

## Results and exit codes

Success results are JSON on stdout. Errors are JSON on stderr with exit code 1:

\`\`\`json
{"error":{"code":"LOGIN_REQUIRED","message":"Use claude-chat login with your existing account email."}}
\`\`\`

Error metadata is inside the \`error\` object; for example, a failed submission
can include \`error.operationId\`. Exit code 0 means the command returned a
result, not necessarily that a pending login or turn finished. Inspect its
\`status\`, \`complete\`, or pagination fields as appropriate.

| Operation | Useful result fields |
| --- | --- |
| Login | \`loginId\`, \`status\`; verification step adds \`approvalUrl\` |
| Auth status | \`authenticated\`, \`account\`, \`validatedAt\`, \`pending\` |
| Account | \`organizations[]\`, \`selectedOrganizationId\` |
| Chat list | \`chats[]\`, \`pagination.continuations[]\`, \`complete\` |
| Chat search | \`hits[]\`, snippets, \`pagination.continuationSupported\` |
| Chat read | \`messages[]\`, \`currentLeafMessageId\`, \`branches.activeMessageIds\` |
| New chat or reply | \`operationId\`, \`chatId\`, \`status\`, \`result.assistant\` when complete |
| Turn status or stop | Saved IDs, \`status\`, reconciliation \`observation\`, final \`result\` when available |

See [agent workflows](agent-guide.md) and [troubleshooting](troubleshooting.md).

To regenerate this file from the repository root:

\`\`\`sh
node claude/scripts/update-command-docs.mjs
node claude/scripts/update-command-docs.mjs --check
\`\`\`
`;
if(process.argv.slice(2).some(argument=>argument!=='--check'))throw new Error('Usage: update-command-docs.mjs [--check]');
if(process.argv.includes('--check')){
 const existing=await fs.readFile(destination,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
 if(existing!==document){process.stderr.write('Command documentation is stale. Run node claude/scripts/update-command-docs.mjs\n');process.exitCode=1;}
}else await fs.writeFile(destination,document);
