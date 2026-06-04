/**
 * Pipeline audio cues — arc-driven cue derivation for whole-episode audio
 * (issue #863 / design doc 2026-06-03-whole-episode-audio-strategy.md, step 3).
 *
 * `audioMode: 'generated'` lays an ordered `cues[]` array — one cue per
 * *narrative arc beat* — onto the episode timeline at stitch time. This module
 * owns the LLM pass that DERIVES that cue list from the episode's own beat
 * prose (`stages.idea` — `.output` beats, `.input` synopsis seed) plus the
 * storyboard scene ordering. Following the design's timing discussion and the
 * #736 reviewers' correction:
 *
 *   - the beats come from the ISSUE's own `stages.idea`, NOT from series-level
 *     arcPlanner output (arcPlanner operates at the season/series level and
 *     emits no per-episode act/sequence structure);
 *   - storyboard `scenes[]` give the scene ORDER but carry no sanitized
 *     per-scene duration, so a cue's `startSec`/`endSec` stay `null` at
 *     derivation time — they are placed at episode-stitch time from the
 *     rendered clips' real durations (the cue muxer in audioMux.js / the
 *     stitch runner owns that placement). This module synthesizes only the
 *     per-cue PROMPT + human label + ordering.
 *
 * Extraction-only, mirroring sceneExtractor.js / arcPlanner.js: the LLM call +
 * sanitization live here, the route owns persistence. Returns
 * `{ cues, runId, providerId, model }`; the route stamps the cues into
 * `stages.audio.cues` (preserving any already-rendered cue's trackFilename
 * where the label still matches, like the per-line render-preserve on
 * re-extract).
 */

import { runStagedLLM } from '../../lib/stageRunner.js';
import { ServerError } from '../../lib/errorHandler.js';
import { trimTo } from '../../lib/storyBible.js';
import {
  AUDIO_CUES_MAX,
  AUDIO_CUE_LABEL_MAX,
  AUDIO_CUE_PROMPT_MAX,
} from './issues.js';

export const ERR_NO_SOURCE = 'PIPELINE_AUDIO_CUES_NO_SOURCE';
export const ERR_EMPTY_RESULT = 'PIPELINE_AUDIO_CUES_EMPTY';

const AUDIO_CUES_STAGE = 'pipeline-audio-cues';

// Compact scene-order summary fed to the prompt so the LLM can size the number
// of arc cues against how much screen time the episode actually has. We pass
// scene headings/summaries (no per-scene timing — there is none) so the cue
// boundaries follow the emotional arc, not a mechanical per-scene split.
const SCENE_SUMMARY_MAX = 240;
const SCENES_FOR_PROMPT_MAX = 120;

function renderScenesForPrompt(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return '(no storyboard scenes yet — derive cues from the episode beats alone)';
  }
  return scenes
    .slice(0, SCENES_FOR_PROMPT_MAX)
    .map((s, i) => {
      const heading = trimTo(s?.heading, 120) || `Scene ${i + 1}`;
      const summary = trimTo(s?.summary, SCENE_SUMMARY_MAX)
        || trimTo(s?.description, SCENE_SUMMARY_MAX)
        || trimTo(s?.visualPrompt, SCENE_SUMMARY_MAX);
      return summary ? `${i + 1}. ${heading} — ${summary}` : `${i + 1}. ${heading}`;
    })
    .join('\n');
}

// The richest episode-beat text available: the LLM-expanded beats
// (`idea.output`) preferred over the synopsis seed (`idea.input`). Trimmed so a
// runaway draft can't blow the prompt budget.
const IDEA_TEXT_MAX = 24_000;
function episodeBeatText(issue) {
  const out = (issue?.stages?.idea?.output || '').trim();
  const input = (issue?.stages?.idea?.input || '').trim();
  return (out || input).slice(0, IDEA_TEXT_MAX);
}

/**
 * Sanitize one LLM-emitted cue into the un-rendered/un-placed cue shape the
 * issue sanitizer (sanitizeAudioCue) will re-validate on persist. We set only
 * the fields derivation OWNS — id/label/prompt/engine — and leave the timeline
 * (startSec/endSec) + render (trackFilename/durationSec) fields null so the
 * design's null-vs-0 sentinel discipline holds: a freshly-derived cue is "not
 * placed, not rendered" until the muxer places it and the render route fills
 * trackFilename.
 */
function sanitizeDerivedCue(raw, i, defaultEngine) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = trimTo(raw.prompt, AUDIO_CUE_PROMPT_MAX);
  // A cue with no prompt can never render — drop it rather than persist a dead
  // entry the render route would 400 on.
  if (!prompt) return null;
  return {
    id: `cue-${String(i + 1).padStart(3, '0')}`,
    label: trimTo(raw.label, AUDIO_CUE_LABEL_MAX) || `Cue ${i + 1}`,
    prompt,
    // Honor a per-cue engine hint when the LLM names one; else fall back to the
    // stage/global default engine so the render route has a concrete target.
    engine: trimTo(raw.engine, 80) || defaultEngine || null,
    startSec: null,
    endSec: null,
    trackFilename: null,
    durationSec: null,
    gain: null,
  };
}

/**
 * Carry forward an already-rendered cue's audio when a re-derivation produces a
 * cue with the same (case-insensitive) label — otherwise re-deriving cues would
 * silently invalidate every previously-rendered cue WAV (mirrors the per-line
 * render-preserve on audio extract-lines). Match on label because ids are
 * positional and re-derivation reshuffles them. Only the render artifacts
 * (trackFilename/durationSec) carry over; prompt/engine come from the fresh
 * derivation so a re-derive can re-tone an existing cue.
 */
export function preserveRenderedCues(freshCues, priorCues) {
  if (!Array.isArray(priorCues) || priorCues.length === 0) return freshCues;
  const renderedByLabel = new Map();
  for (const c of priorCues) {
    const key = (c?.label || '').trim().toLowerCase();
    if (key && c?.trackFilename) renderedByLabel.set(key, c);
  }
  if (renderedByLabel.size === 0) return freshCues;
  return freshCues.map((cue) => {
    const prior = renderedByLabel.get((cue.label || '').trim().toLowerCase());
    if (!prior) return cue;
    return { ...cue, trackFilename: prior.trackFilename, durationSec: prior.durationSec ?? null };
  });
}

/**
 * Derive the arc-beat cue list for one episode. Reads the issue's OWN beat prose
 * (stages.idea) + storyboard scene order, runs the cue-planning LLM pass, and
 * returns sanitized un-rendered cues. Throws a ServerError(400) when the episode
 * has no beat text to derive from.
 *
 * @param {object} issue            the pipeline issue record
 * @param {object} [opts]
 * @param {string} [opts.defaultEngine]   engine id to stamp when a cue omits one
 * @param {string} [opts.providerOverride]
 * @param {string} [opts.modelOverride]
 * @param {object} [opts.series]    `{ name, styleNotes }` for prompt grounding
 */
export async function deriveAudioCues(issue, {
  defaultEngine,
  providerOverride,
  modelOverride,
  series,
} = {}) {
  const beats = episodeBeatText(issue);
  if (!beats) {
    throw new ServerError(
      "Cannot derive audio cues — the episode's Idea stage has no beats or synopsis to drive the arc",
      { status: 400, code: ERR_NO_SOURCE },
    );
  }
  const scenes = Array.isArray(issue?.stages?.storyboards?.scenes)
    ? issue.stages.storyboards.scenes
    : [];

  const { content, runId, providerId, model } = await runStagedLLM(
    AUDIO_CUES_STAGE,
    {
      returnsJson: true,
      series: { name: series?.name || '', styleNotes: series?.styleNotes || '' },
      issue: { number: issue?.number ?? '', title: issue?.title || '' },
      episodeBeats: beats,
      scenesList: renderScenesForPrompt(scenes),
      sceneCount: scenes.length,
      maxCues: AUDIO_CUES_MAX,
    },
    {
      providerOverride,
      modelOverride,
      returnsJson: true,
      source: 'pipeline-audio-cues',
    },
  );

  const rawCues = Array.isArray(content?.cues) ? content.cues : [];
  const cues = rawCues
    .slice(0, AUDIO_CUES_MAX)
    .map((c, i) => sanitizeDerivedCue(c, i, defaultEngine))
    .filter(Boolean)
    // Re-index ids after the filter so they stay sequential cue-001..N.
    .map((cue, i) => ({ ...cue, id: `cue-${String(i + 1).padStart(3, '0')}` }));

  if (cues.length === 0) {
    throw new ServerError(
      'The cue planner returned no usable cues — try regenerating',
      { status: 502, code: ERR_EMPTY_RESULT },
    );
  }

  return { cues, runId, providerId, model };
}

// Export internals for unit tests (the sanitizer is the load-bearing pure part).
export const __testing = {
  sanitizeDerivedCue,
  renderScenesForPrompt,
  episodeBeatText,
};
