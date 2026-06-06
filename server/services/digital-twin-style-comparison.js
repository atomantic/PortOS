/**
 * Digital Twin — Spoken-vs-Written Style Comparison (M34 P5)
 *
 * The first slice of "multi-modal personality capture": compare how the user
 * *speaks* (a pasted/transcribed transcript) against how they *write* (their
 * twin documents, or pasted writing samples) and surface the concrete style
 * differences — formality, verbosity, sentence length, directness, filler
 * words. Returns a suggested `communicationProfile` the user can adopt for
 * voice/spoken contexts.
 *
 * No live capture infra: speech arrives as text (a transcript the user pastes
 * or imports), so this needs no microphone, transcription service, or new
 * persistence. Self-contained — reuses the shared helpers and the existing
 * twin-document content loader only.
 */

import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { callProviderAI } from './digital-twin-helpers.js';
import { getAllTwinContent } from './digital-twin-analysis.js';

const MIN_TRANSCRIPT_CHARS = 100;

/**
 * Compare a spoken transcript against written samples and surface style deltas.
 *
 * @param {object} input
 * @param {string} input.spokenTranscript - transcript of the user speaking
 * @param {string[]} [input.writtenSamples] - written samples; when omitted,
 *   falls back to the user's enabled twin documents
 * @param {string} input.providerId
 * @param {string} input.model
 */
export async function compareSpokenWrittenStyle({ spokenTranscript, writtenSamples, providerId, model }) {
  if (!spokenTranscript || spokenTranscript.trim().length < MIN_TRANSCRIPT_CHARS) {
    return { error: `Spoken transcript must be at least ${MIN_TRANSCRIPT_CHARS} characters` };
  }

  // Use provided written samples, otherwise fall back to the twin's documents
  // so the comparison works even when the user only pastes a transcript.
  let written = Array.isArray(writtenSamples)
    ? writtenSamples.filter(s => typeof s === 'string' && s.trim().length > 0)
    : [];
  let writtenSource = 'provided';

  if (written.length === 0) {
    const twinContent = await getAllTwinContent();
    if (!twinContent || twinContent.trim().length < MIN_TRANSCRIPT_CHARS) {
      return {
        error: 'No written samples provided and not enough twin document content to compare against. Paste a writing sample or add documents first.'
      };
    }
    written = [twinContent];
    writtenSource = 'documents';
  }

  const combinedWritten = written
    .map((s, i) => `--- Written Sample ${i + 1} ---\n${s}`)
    .join('\n\n');

  const prompt = await buildPrompt('twin-spoken-written-compare', {
    spokenTranscript: spokenTranscript.trim(),
    writtenSamples: combinedWritten
  }).catch(() => null);

  if (!prompt) {
    return { error: 'Spoken-vs-written comparison prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt);
  if (result.error || !result.text) {
    return { error: result.error || 'Failed to analyze spoken-vs-written style' };
  }

  return { ...parseStyleComparison(result.text), writtenSource };
}

/**
 * Parse the LLM comparison response into a normalized shape. Tolerates a raw
 * JSON object or a ```json fenced block (same convention as the other twin
 * analyzers). Arrays default to [] and objects to null so the client can
 * distinguish "absent" from "present-but-empty".
 */
export function parseStyleComparison(response) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch
    ? jsonMatch[1]
    : (response.trim().startsWith('{') ? response.trim() : null);

  if (!jsonStr) {
    return { error: 'Failed to parse comparison response - no JSON found', rawResponse: response };
  }

  const parsed = safeJSONParse(jsonStr, null, {
    allowArray: false,
    logError: true,
    context: 'spoken-written comparison'
  });

  if (!parsed) {
    return { error: 'Failed to parse comparison response - invalid JSON', rawResponse: response };
  }

  return {
    spokenProfile: parsed.spokenProfile && typeof parsed.spokenProfile === 'object' ? parsed.spokenProfile : null,
    writtenProfile: parsed.writtenProfile && typeof parsed.writtenProfile === 'object' ? parsed.writtenProfile : null,
    differences: Array.isArray(parsed.differences) ? parsed.differences : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    suggestedCommunicationProfile: parsed.suggestedCommunicationProfile && typeof parsed.suggestedCommunicationProfile === 'object'
      ? parsed.suggestedCommunicationProfile
      : null
  };
}
