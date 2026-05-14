/**
 * Refine a single character's `physicalDescription` so it renders visually
 * distinct from the rest of the cast. The LLM sees the target + every peer's
 * existing description and is asked to commit to specific differentiating
 * choices (ethnicity, age, hair, silhouette, wardrobe palette, ...).
 *
 * Reads/writes go through `getSeries` / `updateSeries` so the regular
 * sanitize-on-write pass still runs.
 */

import { getSeries, updateSeries } from './series.js';
import { getUniverse } from '../universeBuilder.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { ServerError } from '../../lib/errorHandler.js';

const KIND_FIELD = Object.freeze({
  characters: 'physicalDescription',
});

// Slimmed-down peer shape sent to the prompt. Drops timestamps + ids the LLM
// doesn't need so the prompt stays inside the context budget when the cast
// grows past a few entries.
function peerForPrompt(entry) {
  return {
    name: entry.name,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    role: entry.role || '',
    physicalDescription: entry.physicalDescription || entry.description || '',
  };
}

function targetForPrompt(entry) {
  return {
    name: entry.name,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    role: entry.role || '',
    physicalDescription: entry.physicalDescription || '',
    evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
    firstAppearance: entry.firstAppearance || null,
  };
}

export async function refineCharacterDescription(seriesId, entryId, options = {}) {
  const kind = 'characters';
  const field = KIND_FIELD[kind];
  if (!field) {
    throw new ServerError(`Unsupported noun kind: ${kind}`, { status: 400, code: 'PIPELINE_NOUN_KIND' });
  }

  const series = await getSeries(seriesId);
  const list = Array.isArray(series[kind]) ? series[kind] : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`Character ${entryId} not found in series`, {
      status: 404, code: 'PIPELINE_NOUN_NOT_FOUND',
    });
  }
  const target = list[idx];
  const peers = list.filter((_, i) => i !== idx);

  // Style clause: universe stylePrompt (if linked) + series styleNotes, dropped
  // into the prompt as plain text. The LLM doesn't need the full universe JSON —
  // it only steers wardrobe/era cues toward the established aesthetic.
  const universe = series.universeId ? await getUniverse(series.universeId).catch(() => null) : null;
  const styleBits = [
    universe?.stylePrompt ? `Universe aesthetic: ${universe.stylePrompt}` : null,
    series.styleNotes ? `Series notes: ${series.styleNotes}` : null,
  ].filter(Boolean);
  const styleClause = styleBits.length
    ? styleBits.join('\n')
    : '(none provided — pick choices that fit the character\'s role and genre)';

  const result = await runStagedLLM('pipeline-character-refine', {
    targetJson: JSON.stringify(targetForPrompt(target), null, 2),
    peersJson: JSON.stringify(peers.map(peerForPrompt), null, 2),
    styleClause,
  }, {
    providerOverride: options.providerId,
    modelOverride: options.model,
    returnsJson: true,
    source: 'pipeline-character-refine',
  });

  const refined = (result.content?.physicalDescription || '').trim();
  if (!refined) {
    throw new ServerError('LLM returned an empty physicalDescription', {
      status: 502, code: 'PIPELINE_NOUN_REFINE_EMPTY',
    });
  }
  const rationale = (result.content?.rationale || '').trim();
  const changes = Array.isArray(result.content?.changes)
    ? result.content.changes.map((c) => String(c).slice(0, 240)).filter(Boolean).slice(0, 12)
    : [];

  const nextList = list.map((e, i) => i === idx ? { ...e, [field]: refined } : e);
  const updated = await updateSeries(seriesId, { [kind]: nextList });
  const updatedEntry = (updated[kind] || []).find((e) => e.id === entryId) || null;

  console.log(`✨ Pipeline character refine — series=${seriesId.slice(0, 8)} entry=${entryId.slice(0, 8)} runId=${(result.runId || '').slice(0, 8)}`);

  return {
    series: updated,
    entry: updatedEntry,
    rationale,
    changes,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
  };
}
