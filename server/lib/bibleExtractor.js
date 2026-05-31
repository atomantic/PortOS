// Run an LLM bible-extraction stage and sanitize the response through the
// canonical bible shape. Caller owns persistence.

import { runStagedLLM } from './stageRunner.js';
import { sanitizeBibleList, BIBLE_KIND, BIBLE_FIELD, pickPromptFields } from './storyBible.js';

const KIND_STAGE = Object.freeze({
  [BIBLE_KIND.CHARACTER]: 'writers-room-characters',
  [BIBLE_KIND.PLACE]:     'writers-room-places',
  [BIBLE_KIND.OBJECT]:    'writers-room-objects',
});

const EXISTING_VAR = Object.freeze({
  [BIBLE_KIND.CHARACTER]: 'existingCharactersJson',
  [BIBLE_KIND.PLACE]:     'existingPlacesJson',
  [BIBLE_KIND.OBJECT]:    'existingObjectsJson',
});

/**
 * @param {object} args
 * @param {string} args.kind         BIBLE_KIND value
 * @param {string} args.corpus       prose to extract from
 * @param {Array}  [args.existing]   current bible (sent to the prompt for deference)
 * @param {object} [args.context]    extra prompt variables (work, series, issue, ...)
 * @param {string} [args.providerOverride]
 * @param {string} [args.modelOverride] explicit model id (beats stage.model)
 * @param {string} [args.source]     run-tracking source tag
 */
export async function extractBible({
  kind,
  corpus,
  existing = [],
  context = {},
  providerOverride,
  modelOverride,
  source,
}) {
  const stage = KIND_STAGE[kind];
  if (!stage) throw new Error(`extractBible: unknown kind "${kind}"`);
  if (typeof corpus !== 'string' || !corpus.trim()) {
    throw new Error('extractBible: corpus is required');
  }

  const variables = {
    ...context,
    draftBody: corpus,
    returnsJson: true,
    [EXISTING_VAR[kind]]: JSON.stringify((existing || []).map((e) => pickPromptFields(kind, e))),
  };

  const result = await runStagedLLM(stage, variables, {
    providerOverride,
    modelOverride,
    returnsJson: true,
    source: source || `bible-extract-${kind}`,
  });

  const envelopeKey = BIBLE_FIELD[kind];
  const rawList = Array.isArray(result.content?.[envelopeKey]) ? result.content[envelopeKey] : [];
  const extracted = sanitizeBibleList(rawList, kind);

  return {
    extracted,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
  };
}
