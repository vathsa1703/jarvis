import { memoryTools } from '../memory.js';
import claudeCodeTools from './claudeCode.js';
import emailTools from './email.js';
import fileTools from './files.js';
import portfolioTools from './portfolio.js';
import systemTools from './system.js';
import webTools from './web.js';

const RESULT_LIMIT = 12_000;

const tools = [
  ...systemTools,
  ...fileTools,
  ...webTools,
  ...portfolioTools,
  ...emailTools,
  ...claudeCodeTools,
  ...memoryTools,
];

const byName = new Map(tools.map((tool) => [tool.name, tool]));

export const toolSchemas = tools.map(({ name, description, parameters }) => ({
  type: 'function',
  function: { name, description, parameters },
}));

function formatResult(tool, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const clipped = text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n[cut off]` : text;
  if (!tool.untrusted) return clipped;
  // Neutralize a closing tag in the content, so a page can't "end" the wrapper early.
  const safe = clipped.replace(/<\/?untrusted_content/gi, '[tag removed]');
  return `<untrusted_content>\n${safe}\n</untrusted_content>`;
}

// Always returns text for the model. A failed tool is something it should explain,
// not a reason to crash the conversation.
export async function executeTool(name, rawArguments, ctx) {
  const tool = byName.get(name);
  if (!tool) return `Error: there is no tool called "${name}".`;

  let args;
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('not an object');
  } catch {
    return `Error: the arguments for ${name} weren't valid JSON.`;
  }
  const missing = (tool.parameters.required || []).filter((key) => args[key] == null);
  if (missing.length) return `Error: ${name} needs: ${missing.join(', ')}.`;

  try {
    const request = tool.confirm ? await tool.confirm(args) : null;
    if (request && !(await ctx.confirm(request))) {
      return 'The user declined this action, so it did not happen. Do not retry it unless they ask.';
    }
    return formatResult(tool, await tool.run(args, ctx));
  } catch (err) {
    return `Error: ${err.message}`;
  }
}
