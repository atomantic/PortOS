// Tool registry for the voice Chief-of-Staff. Each tool has an OpenAI-format
// function schema (fed to the LLM) plus an execute() that runs the action.
// Add a new tool by pushing another entry onto TOOLS.

import { captureThought } from '../brain.js';

const TOOLS = [
  {
    name: 'brain_capture',
    description:
      'Capture a thought, note, idea, todo, reminder, or any free-form information to the user\'s brain inbox for later classification. Use whenever the user asks you to remember, add, save, note, or jot something down. The text should be in the user\'s own words with enough detail that it\'s useful later.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The content to capture, phrased naturally. Include who/what/when/why details if the user mentioned them.',
        },
      },
      required: ['text'],
    },
    execute: async ({ text }) => {
      if (!text || typeof text !== 'string') throw new Error('text is required');
      const trimmed = text.trim();
      const entry = await captureThought(trimmed);
      // Keep the tool-result payload minimal — anything here is spliced back
      // into the next LLM prompt. Summary is enough for the model to confirm.
      return {
        ok: true,
        id: entry.id,
        summary: `Captured "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}"`,
      };
    },
  },
];

export const getToolSpecs = () => TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export const dispatchTool = async (name, args) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(args || {});
};
