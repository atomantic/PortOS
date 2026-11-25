/**
 * Records what a model actually received beyond user text (#11317).
 *
 * Exports `promptAddition`, `sentPromptRecord`, `carriedPromptAdditions`, `agentInstructionsAddition` and the
 * `promptAdditionsSchema` request field.
 */

import { z } from 'zod';

/**
 * The user's text box keeps only their own words; everything PortOS adds around them is a labeled
 * addition the UI lists as a chip, and `sentPrompt` is the exact final text, so a render can be
 * inspected afterwards even when nothing showed it before the send (autopilot, batch).
 */

// Request-size guard, not a display cap: the server never cuts an addition, only refuses an oversized request.
const ADDITION_TEXT_MAX = 1_000_000;

/** One labeled block PortOS adds to a model's input, or null when it adds nothing. */
export function promptAddition(id, label, text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed ? { id, label, text: trimmed } : null;
}

/** The additions a request already carries (from the composer that built it). */
export const carriedPromptAdditions = (params) => (Array.isArray(params?.promptAdditions)
  ? params.promptAdditions.filter((item) => item && typeof item.text === 'string' && item.text.trim())
  : []);

/**
 * The record fields for a render: the exact text sent, the negative prompt when
 * the engine takes one natively, and every addition (carried ones first, then
 * the backend's own). An addition with no text is dropped.
 */
export function sentPromptRecord({ sentPrompt, sentNegativePrompt = null, carried = [], added = [] }) {
  const additions = [...carried, ...added].filter(Boolean);
  return {
    sentPrompt: typeof sentPrompt === 'string' ? sentPrompt : '',
    ...(typeof sentNegativePrompt === 'string' && sentNegativePrompt.trim() ? { sentNegativePrompt } : {}),
    ...(additions.length ? { promptAdditions: additions } : {}),
  };
}

/**
 * Request schema for the additions a client composer attaches (style presets, universe
 * style). A multipart form sends the list as one JSON string field.
 */
export const promptAdditionsSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.array(z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  text: z.string().min(1).max(ADDITION_TEXT_MAX),
})).max(32).optional());

/**
 * An agent backend's instructions around the prompt (Codex, Grok, Antigravity), as one
 * addition: the backend's own builder run with "[prompt]" in the prompt's place, so
 * the marker lands exactly where the prompt goes and nowhere else.
 */
export function agentInstructionsAddition(label, buildWithPrompt) {
  return promptAddition('agent-instructions', label, buildWithPrompt('[prompt]'));
}
