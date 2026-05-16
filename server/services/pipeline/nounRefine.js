// Rewrite a character's `physicalDescription` so the rendered image differs
// from every peer in the cast. Characters only (settings/objects need
// different prompt fields — punt until there's a real need).

import { getSeries, updateSeries } from './series.js';
import { ServerError } from '../../lib/errorHandler.js';
import { runPromptRefine } from './refineHelpers.js';

const peerForPrompt = (entry) => ({
  name: entry.name,
  aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
  role: entry.role || '',
  physicalDescription: entry.physicalDescription || entry.description || '',
});

const targetForPrompt = (entry) => ({
  ...peerForPrompt(entry),
  evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
  firstAppearance: entry.firstAppearance || null,
});

export async function refineCharacterDescription(seriesId, entryId, options = {}) {
  const series = await getSeries(seriesId);

  // Phase B.3 routing: if the series links to a universe, refine on the
  // universe (where canon actually lives post-Phase-B). Return a series-
  // shaped result so legacy callers — the per-series Nouns page when it
  // takes the orphan branch — don't fork.
  if (series.universeId) {
    // Dynamic import to avoid the universeCanon → series.js cycle on
    // module-init (universeCanon imports updateUniverse, which lives in
    // universeBuilder.js, but the indirect graph still trips).
    const { refineUniverseCharacter } = await import('../universeCanon.js');
    const result = await refineUniverseCharacter(series.universeId, entryId, options);
    return { series, entry: result.entry, rationale: result.rationale, changes: result.changes, runId: result.runId, providerId: result.providerId, model: result.model };
  }

  const list = Array.isArray(series.characters) ? series.characters : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`Character ${entryId} not found in series`, {
      status: 404, code: 'PIPELINE_NOUN_NOT_FOUND',
    });
  }
  const target = list[idx];
  const peers = list.filter((_, i) => i !== idx);

  const universe = null; // orphan-series path only — universeId branch returns early above
  const styleBits = [
    universe?.stylePrompt ? `Universe aesthetic: ${universe.stylePrompt}` : null,
    series.styleNotes ? `Series notes: ${series.styleNotes}` : null,
  ].filter(Boolean);
  const styleClause = styleBits.length
    ? styleBits.join('\n')
    : '(none provided — pick choices that fit the character\'s role and genre)';

  const { refined, changes, rationale, runId, providerId, model } = await runPromptRefine({
    templateName: 'pipeline-character-refine',
    variables: {
      targetJson: JSON.stringify(targetForPrompt(target), null, 2),
      peersJson: JSON.stringify(peers.map(peerForPrompt), null, 2),
      styleClause,
    },
    options,
    source: 'pipeline-character-refine',
    logTag: `Pipeline character refine — series=${seriesId.slice(0, 8)} entry=${entryId.slice(0, 8)}`,
    resultField: 'physicalDescription',
    emptyError: { code: 'PIPELINE_NOUN_REFINE_EMPTY', message: 'LLM returned an empty physicalDescription' },
    changesLimit: 12,
  });

  const nextList = list.map((e, i) => i === idx ? { ...e, physicalDescription: refined } : e);
  const updated = await updateSeries(seriesId, { characters: nextList });
  const updatedEntry = (updated.characters || []).find((e) => e.id === entryId) || null;

  return { series: updated, entry: updatedEntry, rationale, changes, runId, providerId, model };
}
