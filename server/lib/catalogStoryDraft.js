/**
 * New cast, environment or object for a story, drafted from the user's prompt
 * (Casting / Environments / Objects › story filter › New from prompt).
 *
 * The prompt is sent as the user wrote it. The instructions, the universe and
 * the story's context are labeled blocks listed beside it (#11317), so Show
 * full prompt names every word the model read. The answer is a preview: no
 * record exists until the user saves it.
 *
 * Browser-safe: no node-only imports.
 */

import { trimTo } from './textUtils.js';

export const STORY_DRAFT_LIMITS = Object.freeze({ prompt: 4000, name: 200, content: 4000 });

const NOUNS = Object.freeze({ character: 'character', place: 'place (an environment or set)', object: 'object (a prop)' });
const CONTENT_GUIDE = Object.freeze({
  character: 'a physical description an artist can draw from: age, build, face, hair, clothing, and one telling detail',
  place: 'what the place looks like: layout, materials, light, era, and the mood it gives a scene',
  object: 'what the object looks like: size, shape, material, wear, and why it matters to the story',
});

/** The instructions block, sent ahead of the context and shown as its own chip. */
export function storyDraftInstructions(type) {
  const noun = NOUNS[type] || 'story element';
  return [
    `You create one new ${noun} for the story described below, from the user's request.`,
    'Keep it consistent with the universe and the story: their era, tone and the people and places already in it. Do not repeat anyone or anything already listed.',
    'Answer with JSON only, in this shape:',
    '{"name":"","description":""}',
    `- name: a short proper name (at most ${STORY_DRAFT_LIMITS.name} characters).`,
    `- description: ${CONTENT_GUIDE[type] || 'a concrete description'}, in two to five sentences.`,
  ].join('\n');
}

/** The one text the model reads: instructions, then each context block, then the request. */
export function storyDraftPrompt(instructions, contextBlocks, request) {
  const context = contextBlocks.filter(Boolean).map((block) => `${block.label}:\n${block.text}`).join('\n\n');
  return `${instructions}\n\n---\n\n${context ? `${context}\n\n---\n\n` : ''}Request:\n${request}`;
}

/**
 * The draft in a model's answer: the JSON object (fenced or wrapped in prose)
 * reduced to a name and a description. Throws when there is no name.
 */
export function parseStoryDraft(answer) {
  const source = String(answer || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  let parsed = null;
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(source.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  const name = trimTo(parsed?.name, STORY_DRAFT_LIMITS.name);
  if (!name) throw new Error('The model did not answer with a name in the asked-for JSON.');
  return { name, content: trimTo(parsed?.description, STORY_DRAFT_LIMITS.content) };
}
