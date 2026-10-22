/**
 * Beats from a plot summary (storyboard editor › Beats from plot).
 *
 * `extractBeats` saves the plot and the LLM pick on the board (so the form
 * remembers both), sends the plot to that provider with the visible beat
 * instructions, and answers with the beats as a PREVIEW plus the exact prompt
 * sent. `addBeats` appends the beats the user keeps. Runs only on the user's
 * tap; nothing here is called at boot or in the background.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { promptAddition } from '../../lib/modelInput.js';
import { CREATIVE_LATITUDE_ADDITION, withCreativeLatitude } from '../../lib/creativeLatitude.js';
import { beatExtractInstructions, beatExtractPrompt, parseExtractedBeats } from '../../lib/storyboardBeatExtract.js';
import { STORYBOARD_LIMITS } from '../../lib/storyboardVocabulary.js';
import { mutateStoryboard } from './index.js';

// Overridable for tests (the provider runner is a process singleton).
const deps = {
  resolveProvider: async (args) => (await import('../promptRunner.js')).resolveProviderAndModel(args),
  runPrompt: async (args) => (await import('../promptRunner.js')).runPromptThroughProvider(args),
};
export const __setPlotDepsForTests = (overrides) => Object.assign(deps, overrides);

const refuse = (message, code = 'STORYBOARD_PLOT_REFUSED', status = 400) => new ServerError(message, { status, code });

export async function extractBeats(storyboardId, { plot, providerId = '', model = '', effort = '' }) {
  const { board } = await mutateStoryboard(storyboardId, (draft) => {
    draft.plot = plot;
    draft.plotLlm = { providerId, model, effort };
  });
  if (!board.plot) throw refuse('Write the plot summary first.');

  const { provider, selectedModel } = await deps.resolveProvider({ providerId: providerId || null, model: model || null });
  if (!provider) throw refuse('No AI provider is set up; pick one first.', 'NO_PROVIDER', 503);
  if (provider.enabled === false) throw refuse(`Provider "${provider.name || provider.id}" is disabled; enable it in Settings › Providers first.`, 'PROVIDER_DISABLED');

  const instructions = beatExtractInstructions();
  const sentPrompt = withCreativeLatitude(beatExtractPrompt(instructions, board.plot));
  const promptAdditions = [CREATIVE_LATITUDE_ADDITION, promptAddition('beat-instructions', 'Beat instructions', instructions)];
  const result = await deps.runPrompt({
    provider, model: selectedModel, effort: effort || undefined, prompt: sentPrompt, source: 'storyboard-plot-beats',
  });
  let beats;
  try {
    beats = parseExtractedBeats(result?.text);
  } catch (err) {
    throw refuse(`${err.message} Try again, or pick another model.`, 'STORYBOARD_PLOT_UNREADABLE', 422);
  }
  console.log(`📝 Storyboard ${storyboardId.slice(0, 11)} plot → ${beats.length} beat(s) via ${provider.id}`);
  return { board, beats, sentPrompt, promptAdditions, providerId: provider.id, model: selectedModel || '' };
}

/** Append previewed beats (with their panels) after the board's last beat. */
export async function addBeats(storyboardId, beats) {
  const { board } = await mutateStoryboard(storyboardId, (draft) => {
    const panelCount = draft.beats.reduce((sum, beat) => sum + beat.panels.length, 0) + beats.reduce((sum, beat) => sum + beat.panels.length, 0);
    if (draft.beats.length + beats.length > STORYBOARD_LIMITS.beats || panelCount > STORYBOARD_LIMITS.panelsTotal) {
      throw new ServerError(`A storyboard holds at most ${STORYBOARD_LIMITS.beats} beats and ${STORYBOARD_LIMITS.panelsTotal} panels; remove some first.`, { status: 409, code: 'STORYBOARD_LIMIT' });
    }
    draft.beats.push(...beats.map((beat) => ({ ...beat, panels: beat.panels.map((panel) => ({ ...panel })) })));
  });
  return board;
}
