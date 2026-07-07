/**
 * Pipeline — Series Voice Discovery (#2179, CWQE Phase 14).
 *
 * The phase headline: concrete prose anchors the voice far better than an
 * adjective list ("witty, atmospheric") ever can, so instead of asking the user
 * to *describe* the voice we let them *hear* it. Given a series + its linked
 * universe, this runs ONE LLM call that writes the SAME short scene beat in each
 * of the distinct registers in `VOICE_REGISTERS` (spare / lyric / wry /
 * close-psychic / cinematic). The user (or, in autonomous mode, the calibrated
 * judge) picks the passage that fits by ear — the picked one lands in
 * `voiceExemplars` ("the tuning fork"), rejected ones can drop into
 * `voiceAntiExemplars`.
 *
 * Like `generateSeriesConcept`, this does NOT persist anything — it returns
 * candidates the UI presents side-by-side; the user's pick is committed via the
 * ordinary series PATCH (styleGuide.voiceExemplars). This is an explicit
 * user-triggered action, so it satisfies the "no cold-bootstrap LLM calls" AI
 * policy — nothing here fires on boot or in a background job.
 *
 * Throws ServerError(502, PIPELINE_VOICE_DISCOVER_EMPTY) on unusable output —
 * matches the other refine helpers' error shape so the UI surfaces a uniform
 * "try again" toast.
 */

import { getSeries, NAME_MAX } from './series.js';
import { getUniverse, joinInfluenceList } from '../universeBuilder.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  VOICE_REGISTERS, VOICE_REGISTER_IDS, STYLE_GUIDE_LIMITS, composeStyleNotes,
} from '../../lib/styleGuide.js';

// Render the register menu into the prompt: one bullet per register the model
// must write a passage for, keyed by the stable id it echoes back.
const REGISTERS_BLOCK = VOICE_REGISTERS
  .map((r) => `- \`${r.id}\` (${r.label}): ${r.hint}`)
  .join('\n');

function buildContext(series, universe) {
  // The composed style guide + free-text notes give the model the world's tone —
  // but we strip any EXISTING voice exemplars/anti-exemplars first. composeStyleNotes
  // otherwise folds them in as "MATCH this voice" / "NEVER drift toward this"
  // blocks, which would homogenize a re-run's trial passages toward the
  // already-picked voice — the opposite of discovery, whose whole point is to
  // surface deliberately contrasting registers. So the register hints supply the
  // contrast; the tone/notes supply the world.
  const guide = series?.styleGuide;
  const seriesForContext = guide
    ? { ...series, styleGuide: { ...guide, voiceExemplars: [], voiceAntiExemplars: [] } }
    : series;
  const styleContext = composeStyleNotes(seriesForContext) || '';
  return {
    series: {
      name: (series.name || '').slice(0, NAME_MAX),
      logline: (series.logline || '').slice(0, 500),
      premise: (series.premise || '').slice(0, 4000),
      styleContext: styleContext.slice(0, 4000),
    },
    hasUniverse: !!universe,
    universe: {
      name: (universe?.name || '').slice(0, 200),
      premise: (universe?.premise || '').slice(0, 2000),
      embrace: joinInfluenceList(universe?.influences?.embrace) || '(none)',
      avoid: joinInfluenceList(universe?.influences?.avoid) || '(none)',
    },
    registers: REGISTERS_BLOCK,
    // Passages are exemplar-length by construction — reuse the exemplar cap so a
    // picked candidate never overflows the styleGuide sanitizer on commit.
    passageMaxChars: STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX,
  };
}

// Normalize one LLM candidate to `{ register, label, passage, note }`. Drops a
// candidate whose register id we don't recognize or whose passage is empty —
// the caller filters nulls out. `passage` is clamped to the exemplar char cap
// so a committed pick round-trips cleanly through `cleanExemplars`.
function normalizeCandidate(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const registerId = typeof raw.register === 'string' ? raw.register.trim() : '';
  const meta = VOICE_REGISTERS.find((r) => r.id === registerId);
  if (!meta) return null;
  const passage = typeof raw.passage === 'string'
    ? raw.passage.trim().slice(0, STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX)
    : '';
  if (!passage) return null;
  const note = typeof raw.note === 'string'
    ? raw.note.trim().slice(0, STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX)
    : '';
  return note ? { register: meta.id, label: meta.label, passage, note }
    : { register: meta.id, label: meta.label, passage };
}

export async function discoverSeriesVoice(seriesId, options = {}) {
  // getSeries throws the pipeline series NOT_FOUND code, which the route's
  // mapServiceError already translates to a 404 — so a stale id reads as bad
  // input, not a server fault.
  const series = await getSeries(seriesId);
  const universe = series.universeId
    ? await getUniverse(series.universeId).catch(() => null)
    : null;
  const emptyError = {
    code: 'PIPELINE_VOICE_DISCOVER_EMPTY',
    message: 'LLM returned no usable voice passages — try again or pick a different provider.',
  };
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'pipeline-series-voice-discover',
    variables: buildContext(series, universe),
    options,
    source: 'pipeline-series-voice-discover',
    logTag: `Voice discovery — series=${seriesId.slice(0, 8)}`,
    emptyError,
    validateContent: (c) => {
      if (!Array.isArray(c?.candidates)) {
        throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
      }
    },
  });
  // Dedupe by register (a model that emits two `spare` passages should not
  // crowd out a missing one) and keep the canonical register order so the
  // side-by-side UI is stable across runs.
  const seen = new Set();
  const byRegister = new Map();
  for (const raw of content.candidates) {
    const cand = normalizeCandidate(raw);
    if (!cand || seen.has(cand.register)) continue;
    seen.add(cand.register);
    byRegister.set(cand.register, cand);
  }
  const candidates = VOICE_REGISTER_IDS
    .map((id) => byRegister.get(id))
    .filter(Boolean);
  if (!candidates.length) {
    throw new ServerError(emptyError.message, { status: 502, code: emptyError.code });
  }
  return { candidates, rationale, runId, providerId, model };
}
