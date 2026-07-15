/**
 * Model Personality self-profile testing (issue #2610).
 *
 * Asks a chosen model to run a deep introspective self-evaluation in a single
 * prompt and return a structured personality attribute map, plus an optional
 * follow-up alignment score against the digital twin's stored trait profile.
 *
 * AI policy: both LLM calls fire ONLY from `runPersonalityTest`, which is only
 * reachable via the explicit POST /api/model-personality/run user action —
 * no boot-time calls, no background batches.
 *
 * Storage: results live in `data/model-personality/results.json` — a
 * regenerable, capped, install-local log OUTSIDE `data/digital-twin/` (the
 * twin dir is checksummed for federation and its meta.json merges whole-body
 * LWW, which would lose appended history across machines). No dataSync
 * category, no peer-sync record kind — provider ids are per-install anyway.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { resolveProviderAndModel, runPromptThroughProvider, assertProvider } from '../lib/promptRunner.js';
import {
  PERSONALITY_TAXONOMY_VERSION,
  PERSONALITY_TRAIT_KEYS,
  personalityProfileResponseSchema,
  personalityAlignmentResponseSchema
} from '../lib/modelPersonalityValidation.js';
import { buildPrompt } from './promptService.js';
import { loadMeta } from './digital-twin-meta.js';

export const DEFAULT_SETTINGS = Object.freeze({
  scorerProviderId: null, // null → score with the same provider that self-profiled
  scorerModel: null,
  historyCap: 200,
  defaultIncludeAlignment: true
});

export const ALIGNMENT_SKIPPED_NO_TRAITS =
  'The digital twin has no analyzed traits yet — run a trait analysis on the Digital Twin Identity tab first.';

// Paths resolve lazily so test mocks that redirect PATHS.data take effect.
const resultsFile = () => join(PATHS.data, 'model-personality', 'results.json');
const settingsFile = () => join(PATHS.data, 'model-personality', 'settings.json');

export async function getSettings() {
  const stored = await readJSONFile(settingsFile(), {});
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

export async function updateSettings(patch = {}) {
  const next = { ...(await getSettings()), ...patch };
  await atomicWrite(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

export async function getHistory(limit) {
  const stored = await readJSONFile(resultsFile(), []);
  const list = Array.isArray(stored) ? stored : [];
  return typeof limit === 'number' ? list.slice(0, limit) : list;
}

// Serialize results.json mutations: a run finishing while a delete is in
// flight would otherwise read-modify-write the same file and drop one of the
// two changes.
const queueResultsWrite = createFileWriteQueue();

export async function deleteResult(runId) {
  return queueResultsWrite(async () => {
    const list = await getHistory();
    const next = list.filter((r) => r.runId !== runId);
    if (next.length === list.length) return false;
    await atomicWrite(resultsFile(), JSON.stringify(next, null, 2));
    return true;
  });
}

function appendResult(record, historyCap) {
  return queueResultsWrite(async () => {
    const list = await getHistory();
    list.unshift(record);
    await atomicWrite(resultsFile(), JSON.stringify(list.slice(0, historyCap), null, 2));
  });
}

/**
 * Parse a runner response that was validated/coerced against `schema` by
 * runPromptThroughProvider. The runner guarantees `text` satisfies the schema
 * on success, so a failure here means the runner contract broke — surface it.
 */
function parseSchemaText(text, schema, label) {
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${label} response failed schema validation after runner coercion`);
  return parsed.data;
}

/** True when the twin has at least one analyzed trait surface to align against. */
export function twinHasTraits(traits) {
  return !!(
    traits &&
    (traits.bigFive ||
      traits.communicationProfile ||
      (Array.isArray(traits.valuesHierarchy) && traits.valuesHierarchy.length > 0))
  );
}

/**
 * Run the personality self-profile test against one provider/model.
 *
 * Call 1 (always): the blind single-prompt self-evaluation — deliberately NO
 * twin context, so the self-report isn't anchored on the target profile.
 * Call 2 (only when alignment is requested AND the twin has analyzed traits):
 * feed the self-reported map + twin traits to the configured scorer provider.
 *
 * Persists the EFFECTIVE provider/model the runner reports (CLI providers may
 * ignore per-call overrides), unshifts the record into the capped history, and
 * returns it.
 */
export async function runPersonalityTest({ providerId, model, includeAlignment, personaId = null } = {}) {
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, {
    message: 'No AI provider available for the personality self-profile',
    code: 'NO_PROVIDER'
  });

  const settings = await getSettings();
  const wantAlignment = includeAlignment ?? settings.defaultIncludeAlignment;

  const prompt = await buildPrompt('model-personality-profile', {
    traitKeys: PERSONALITY_TRAIT_KEYS.join(', ')
  });
  const run = await runPromptThroughProvider({
    provider,
    prompt,
    source: 'model-personality-profile',
    model: selectedModel ?? undefined,
    responseSchema: personalityProfileResponseSchema
  });
  const profile = parseSchemaText(run.text, personalityProfileResponseSchema, 'Self-profile');

  const record = {
    runId: randomUUID(),
    providerId: run.provider?.id || provider.id,
    model: run.model ?? selectedModel ?? null, // effective model, not the requested one
    timestamp: new Date().toISOString(),
    taxonomyVersion: PERSONALITY_TAXONOMY_VERSION,
    traits: profile.traits,
    summary: profile.summary,
    ...(personaId ? { personaId } : {})
  };

  if (wantAlignment) {
    Object.assign(record, await scoreAlignment(record, settings));
  }

  await appendResult(record, settings.historyCap);
  console.log(
    `🧠 Personality self-profile complete: ${record.providerId}/${record.model ?? 'default'}${
      record.alignment ? ` — alignment ${Math.round(record.alignment.alignmentScore * 100)}%` : ''
    }`
  );
  return record;
}

/**
 * Score the self-reported profile against the twin's stored traits.
 * Returns `{ alignment, scorerProviderId, scorerModel }` on success, or
 * `{ alignmentSkipped }` with a clear message when the twin has no analyzed
 * traits yet (no scorer call is made in that case).
 */
async function scoreAlignment(record, settings) {
  const meta = await loadMeta();
  if (!twinHasTraits(meta?.traits)) {
    return { alignmentSkipped: ALIGNMENT_SKIPPED_NO_TRAITS };
  }
  const twinTraits = meta.traits;

  const { provider, selectedModel } = await resolveProviderAndModel({
    providerId: settings.scorerProviderId || record.providerId,
    model: settings.scorerModel || undefined
  });
  assertProvider(provider, {
    message: 'No AI provider available for the alignment scorer',
    code: 'NO_PROVIDER'
  });

  const prompt = await buildPrompt('model-personality-alignment-scorer', {
    selfProfile: JSON.stringify({ traits: record.traits, summary: record.summary }, null, 2),
    twinTraits: JSON.stringify(
      {
        bigFive: twinTraits.bigFive,
        communicationProfile: twinTraits.communicationProfile,
        valuesHierarchy: twinTraits.valuesHierarchy
      },
      null,
      2
    )
  });
  const run = await runPromptThroughProvider({
    provider,
    prompt,
    source: 'model-personality-alignment',
    model: selectedModel ?? undefined,
    responseSchema: personalityAlignmentResponseSchema
  });
  const parsed = parseSchemaText(run.text, personalityAlignmentResponseSchema, 'Alignment');

  return {
    alignment: { alignmentScore: parsed.alignmentScore, dimensions: parsed.dimensions },
    scorerProviderId: run.provider?.id || provider.id,
    scorerModel: run.model ?? selectedModel ?? null
  };
}
