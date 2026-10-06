/**
 * Music Video cover art — the design brief for one song's single artwork.
 *
 * Each song gets its own look, drafted from the song itself (title, lyrics,
 * the video's concept and visual direction) plus whatever the director typed
 * ("grainy black and white, tiny lowercase type", "make the title bigger").
 * The answer is a lettering design in coverArtCompose.js's vocabulary and a
 * prompt for the cover photo. Pure: project in, prompt out; text in, design out.
 */
import { extractJson } from '../../lib/jsonExtract.js';
import { fenceBlock } from '../../lib/promptFencing.js';
import { trimTo } from '../../lib/textUtils.js';
import { COVER_DESIGN_OPTIONS, normalizeCoverDesign } from './coverArtCompose.js';

const lyricsText = (project) => (project?.lyricCues || []).map((c) => (typeof c?.text === 'string' ? c.text.trim() : '')).filter(Boolean).join('\n');

/**
 * The drafting prompt. With a `previous` design the direction is an
 * adjustment to it; without one it is a fresh design (the direction, when
 * given, steering it).
 */
export function buildCoverDesignPrompt(project, { direction = '', previous = null } = {}) {
  const castDirection = project?.castAndSets?.direction || {};
  const p = castDirection.protagonist || {};
  const facts = [
    `Song title: ${project?.name || 'Untitled'}`,
    project?.concept?.style ? `The video's visual style: ${trimTo(project.concept.style, 800)}` : null,
    castDirection.look ? `The video's photographic look: ${trimTo(castDirection.look, 600)}` : null,
    [p.face, p.hair, p.signature].some(Boolean) ? `The singer: ${trimTo([p.face, p.hair, p.signature].filter(Boolean).join('; '), 600)}` : null,
  ].filter(Boolean).join('\n');
  const options = Object.entries(COVER_DESIGN_OPTIONS).map(([k, list]) => `  "${k}": one of ${list.map((v) => `"${v}"`).join(', ')}`).join(',\n');
  return [
    'You are the art director for a single\'s cover artwork (the square image Spotify shows). Design a look that is this song\'s own: grow it from the song\'s words and its video\'s world, not from a genre template or another artist\'s cover.',
    'The cover is one photograph with the song title and artist name set over it in type. You choose the photo and the type treatment.',
    facts,
    fenceBlock('Lyrics', lyricsText(project) || '(no lyrics)', 3000),
    previous ? fenceBlock('The current design (adjust it; keep what the direction does not change)', JSON.stringify(previous), 3000) : '',
    direction ? fenceBlock(previous ? "The artist's adjustment" : "The artist's direction", direction, 1500) : '',
    'Return ONLY a JSON object:',
    `{
  "imagePrompt": "the cover photograph to generate, in one paragraph: subject, framing, light, palette, texture. Square. No text or lettering in the image. Leave calm space where the title goes.",
  "design": {
${options},
    "tracking": letter spacing in em from -0.05 to 0.3,
    "titleColor": "#rrggbb",
    "accentColor": "#rrggbb (artist name, rule, band)",
    "rule": true or false (a thin accent line by the title)
  },
  "rationale": "one sentence on why this look fits this song"
}`,
  ].filter(Boolean).join('\n\n');
}

/** The model's answer as `{ design, imagePrompt, rationale }`, or null when it has no usable design. */
export function parseCoverDesign(text) {
  const { value } = extractJson(text, { blockType: 'object' });
  if (!value || typeof value !== 'object' || !value.design || typeof value.design !== 'object') return null;
  return {
    design: normalizeCoverDesign(value.design),
    imagePrompt: trimTo(typeof value.imagePrompt === 'string' ? value.imagePrompt : '', 1500),
    rationale: trimTo(typeof value.rationale === 'string' ? value.rationale : '', 300),
  };
}
