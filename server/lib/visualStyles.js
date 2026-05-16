/**
 * Curated catalog of named visual-style presets injected into every pipeline
 * image-gen call. Catalog is additive-only: never renumber existing ids, since
 * they are the persisted contract on `series.visualStyleDefault` and
 * `issue.stages.<id>.visualStyleOverride`.
 */

import { trimTo } from './storyBible.js';

export const CUSTOM_PROMPT_MAX = 2000;

export const VISUAL_STYLES = Object.freeze([
  {
    id: 'graphic-novel',
    name: 'Graphic Novel',
    description: 'Bold ink lines, halftone dots, saturated comic-book colors, panel-ready aesthetic.',
    promptFragment: 'graphic novel aesthetic, bold ink outlines, halftone shading dots, saturated comic-book color palette, dynamic compositions, clean panel-ready linework',
  },
  {
    id: 'cinematic',
    name: 'Cinematic Realism',
    description: 'Photorealistic film look, 35mm grain, shallow depth of field, dramatic lighting.',
    promptFragment: 'photorealistic, 35mm film, shallow depth of field, dramatic key lighting, soft falloff, cinematic color grade',
  },
  {
    id: 'anime',
    name: 'Anime',
    description: 'Cel-shaded Japanese animation, bold lines, vivid colors, expressive features.',
    promptFragment: 'anime style, Japanese animation, vivid colors, expressive features, cel-shaded, clean line art',
  },
  {
    id: 'film-noir',
    name: 'Film Noir',
    description: 'High-contrast black and white, deep shadows, hard light sources, chiaroscuro.',
    promptFragment: 'film noir, high contrast black and white, deep shadows, dramatic chiaroscuro lighting, hard light sources, venetian-blind shadows',
  },
  {
    id: 'watercolor',
    name: 'Watercolor',
    description: 'Soft washes, bleeding edges, hand-painted feel, visible paper texture.',
    promptFragment: 'watercolor painting style, soft washes, bleeding edges, hand-painted, visible paper texture, organic pigment pooling',
  },
  {
    id: 'oil-painting',
    name: 'Oil Painting',
    description: 'Classical fine art, rich impasto brushwork, layered glazes.',
    promptFragment: 'classical oil painting, rich impasto brushwork, layered glazes, painterly edges, gallery-style finish',
  },
  {
    id: 'pixar-3d',
    name: '3D Animation',
    description: 'Stylized 3D characters and environments, soft global illumination, family-friendly look.',
    promptFragment: 'stylized 3D animation, Pixar-grade rendering, soft global illumination, expressive proportions, polished surface shaders',
  },
  {
    id: 'retro-70s',
    name: 'Retro 70s',
    description: 'Warm film grain, faded Kodachrome palette, soft vignette, vintage feel.',
    promptFragment: 'retro 1970s film, warm grain, faded Kodachrome colors, vintage lens, soft focus vignette, occasional film burn',
  },
  {
    id: 'scifi-neon',
    name: 'Sci-Fi Neon',
    description: 'Cyberpunk neon glow, holographic UI, dark cityscapes, colored light spill.',
    promptFragment: 'sci-fi cyberpunk, neon glow, holographic UI, futuristic, dark atmosphere with colored light spill, rain-slick streets',
  },
  {
    id: 'documentary',
    name: 'Documentary',
    description: 'Naturalistic handheld feel, available light, real-world textures.',
    promptFragment: 'documentary style, naturalistic, handheld camera feel, available light, real-world textures, observational framing',
  },
  {
    id: 'dark-fantasy',
    name: 'Dark Fantasy',
    description: 'Epic scale, magical lighting, otherworldly atmosphere, ethereal glow.',
    promptFragment: 'dark fantasy art, ethereal glow, magical particles, epic landscapes, otherworldly atmosphere, painterly fantasy illustration',
  },
  {
    id: 'minimalist',
    name: 'Minimalist',
    description: 'Clean lines, muted palette, simple compositions with negative space.',
    promptFragment: 'minimalist illustration, clean lines, muted palette, generous negative space, simple geometric compositions',
  },
  {
    id: 'flat-vector',
    name: 'Flat Vector Explainer',
    description: 'Bold geometric shapes, vivid saturated palette, clean edges, explainer-video style.',
    promptFragment: 'flat vector illustration, bold geometric shapes, vivid saturated palette, clean edges, explainer-video aesthetic',
  },
  {
    id: 'lined-illustration',
    name: 'Lined Illustration',
    description: 'Hand-drawn outlines with textured fills, warm earthy tones, organic feel.',
    promptFragment: 'hand-drawn illustration, organic outlines with textured fills, warm earthy tones, sketchy editorial feel',
  },
  {
    id: 'paper-cutout',
    name: 'Paper Cut-Out',
    description: 'Layered paper craft, torn edges, collage-like compositions, stop-motion feel.',
    promptFragment: 'paper cut-out craft style, layered paper depth, torn edges, collage compositions, stop-motion feel',
  },
]);

const STYLES_BY_ID = new Map(VISUAL_STYLES.map((s) => [s.id, s]));

export function getVisualStyle(id) {
  if (!id || typeof id !== 'string') return null;
  return STYLES_BY_ID.get(id) || null;
}

// Catalog default per stage. Comic pages render to a graphic-novel aesthetic
// unless overridden; storyboards/episode videos default to cinematic so shot
// composition reads like film. Series-level default still wins when set.
const STAGE_FALLBACK = Object.freeze({
  comicPages: 'graphic-novel',
  storyboards: 'cinematic',
  episodeVideo: 'cinematic',
});

/**
 * Sanitize a visualStyleDefault / visualStyleOverride payload. Returns either
 * a valid object or `null` so readers don't have to defensively spread.
 *
 * Allows `{ id: null, customPrompt: "..." }` so a user can supply a one-off
 * custom style without picking a catalog preset.
 */
export function sanitizeVisualStyleRef(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const validId = id && STYLES_BY_ID.has(id) ? id : null;
  const customPrompt = trimTo(raw.customPrompt, CUSTOM_PROMPT_MAX);
  if (!validId && !customPrompt) return null;
  return { id: validId, customPrompt: customPrompt || null };
}

/**
 * Resolve the effective style for a stage. Priority:
 *   1. issue.stages[stageId].visualStyleOverride
 *   2. series.visualStyleDefault
 *   3. STAGE_FALLBACK[stageId]
 *
 * The persisted refs are re-sanitized on read so hand-edited JSON and
 * future catalog deletions degrade gracefully instead of producing a broken
 * empty fragment.
 */
export function resolveVisualStyle(series, issue, stageId) {
  const override = sanitizeVisualStyleRef(issue?.stages?.[stageId]?.visualStyleOverride);
  const seriesDefault = sanitizeVisualStyleRef(series?.visualStyleDefault);
  const fallbackId = STAGE_FALLBACK[stageId] || null;
  const fallback = fallbackId ? { id: fallbackId, customPrompt: null } : null;
  const ref = override || seriesDefault || fallback;
  if (!ref) return null;
  const catalog = ref.id ? getVisualStyle(ref.id) : null;
  const fragmentParts = [
    catalog?.promptFragment || '',
    ref.customPrompt || '',
  ].map((p) => p.trim()).filter(Boolean);
  if (fragmentParts.length === 0) return null;
  return {
    id: ref.id,
    name: catalog?.name || 'Custom',
    promptFragment: fragmentParts.join(', '),
  };
}

// Returned as a plain (non-frozen) array so JSON serialization doesn't trip
// over the readonly trap on the catalog reference.
export function listVisualStyles() {
  return VISUAL_STYLES.map((s) => ({ ...s }));
}
