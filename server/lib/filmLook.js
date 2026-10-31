/**
 * Film look — the finishing filter a music video (or a single still) is viewed
 * through: soft focus, halation, color bleed, grain, fade, vignette, light
 * leaks, gate weave and the rest of the analog toolbox, as a stack of tunable
 * controls with named presets.
 *
 * ONE implementation serves every surface: an SVG filter (`filmLookFilterMarkup`)
 * that the composition live preview, the final render's browser and the gallery
 * still editor all apply with `filter: url(#…)`. Every effect that varies over
 * time (grain, weave, flicker, leak drift) is a pure function of the song FRAME,
 * never of RNG state or wall time, so an excerpt, a re-render, the live preview
 * and the four worker browsers of a split render all draw the same frame.
 *
 * `filmLookFilterMarkup` and `filmLookRuntimeSource` are inlined into sandboxed
 * pages by `toString()`, so they must stay self-contained: no references to
 * module scope, no imports. `FILM_LOOK_CONTROLS` is the single table the UI, the
 * Zod schema (`filmLookValidation.js`) and the normalizer are built from.
 */

export const FILM_LOOK_VERSION = 1;

export const FILM_LOOK_GROUPS = Object.freeze([
  { id: 'focus', label: 'Focus & glow' },
  { id: 'color', label: 'Color' },
  { id: 'texture', label: 'Texture' },
  { id: 'frame', label: 'Frame & leak' },
  { id: 'motion', label: 'Continuous film motion',
    hint: 'Runs under every frame. Timed film events (gate jumps, shutter blinks, a leak at a moment) are set on each shot\'s Effects.' },
]);

// Each control: a slider (`min`/`max`/`step`, `def` default), a color, or a
// toggle. `term` is the cinematography / photography word for it and `words`
// turns a value into prompt language, so the panel teaches the vocabulary a
// user needs to ask an image or video model for the same quality directly.
export const FILM_LOOK_CONTROLS = Object.freeze([
  { id: 'defocus', group: 'focus', label: 'Soft focus', term: 'defocus · missed focus', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'How far the whole picture sits from sharp. Lenses, not post, call this missed focus.',
    words: (v) => (v > 0.6 ? 'heavily out of focus, dreamy missed focus' : v > 0.3 ? 'soft focus, slightly out of focus' : 'gently softened focus') },
  { id: 'diffusion', group: 'focus', label: 'Diffusion', term: 'Pro-Mist · glow filter', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'A glass diffusion filter: light spreads into a soft glow while edges stay readable.',
    words: (v) => (v > 0.5 ? 'heavy diffusion filter glow, blooming soft light' : 'subtle Pro-Mist diffusion, soft glowing light') },
  { id: 'halation', group: 'focus', label: 'Halation', term: 'halation · highlight bloom', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Film lets bright light bounce back through the emulsion: warm halos around lamps, signs and skin highlights.',
    words: (v) => (v > 0.5 ? 'strong red-orange halation around highlights, blooming neon' : 'soft halation around light sources') },
  { id: 'halationSpread', group: 'focus', label: 'Halation spread', term: 'halation size · emulsion scatter', min: 0, max: 1, step: 0.01, def: 0, modifier: 'halation', since: 2,
    hint: 'How far the halo reaches past the highlight. Low hugs the edge like fine-grain stock; high blooms across the frame like a cine print.',
    words: (v) => (v > 0.5 ? 'wide blooming halation' : 'tight halation hugging bright edges') },
  { id: 'halationColor', group: 'focus', label: 'Halation color', term: 'halation tint', type: 'color', def: '#ff5a1f',
    hint: 'Film halation is red-orange (the anti-halation layer passes red). Change it for a stylized glow.' },
  { id: 'chroma', group: 'focus', label: 'Color fringing', term: 'chromatic aberration', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'A cheap lens focuses red and blue at different points: colored fringes at edges, strongest off-center.',
    words: () => 'chromatic aberration, color fringing at edges, cheap lens' },
  { id: 'edgeSoftness', group: 'focus', label: 'Lens fall-off', term: 'soft corners · vintage lens', min: 0, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'Sharp in the middle, softer toward the edges: an old fast lens wide open, which also reads as shallow depth of field.',
    words: (v) => (v > 0.5 ? 'vintage lens wide open, soft swirling edges, shallow depth of field' : 'vintage lens, gently soft corners') },
  { id: 'smear', group: 'focus', label: 'Tape softness', term: 'horizontal smear · VHS resolution', min: 0, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'Videotape keeps vertical detail but loses horizontal detail, so edges smear sideways and fine texture goes mushy.',
    words: (v) => (v > 0.5 ? 'smeary low-resolution VHS picture' : 'soft analog video picture') },
  { id: 'bleed', group: 'focus', label: 'Color bleed', term: 'chroma smear · VHS bleed', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Tape and broadcast carry color at lower resolution than brightness, so colors smear sideways past their edges.',
    words: (v) => (v > 0.5 ? 'heavy VHS color bleed, smeared chroma' : 'slight analog color bleed') },

  { id: 'exposure', group: 'color', label: 'Exposure', term: 'exposure · stops', min: -1, max: 1, step: 0.01, def: 0,
    hint: 'Overall brightness, about one stop either way.',
    words: (v) => (v > 0 ? 'overexposed, bright' : 'underexposed, dim') },
  { id: 'contrast', group: 'color', label: 'Contrast', term: 'contrast · tonal range', min: -1, max: 1, step: 0.01, def: 0,
    hint: 'Negative flattens the picture toward a faded print; positive deepens blacks and pushes whites.',
    words: (v) => (v > 0 ? 'high contrast, punchy' : 'low contrast, flat, muted tonal range') },
  { id: 'fade', group: 'color', label: 'Fade', term: 'lifted blacks · faded print', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Raises the blacks to a milky gray and holds back the whites, the way an old print or an expired stock looks.',
    words: (v) => (v > 0.5 ? 'faded print, washed-out lifted blacks, matte' : 'slightly faded, lifted blacks') },
  { id: 'saturation', group: 'color', label: 'Saturation', term: 'saturation · chroma', min: -1, max: 1, step: 0.01, def: 0,
    hint: 'Negative drains color toward monochrome; positive pushes it toward slide film.',
    words: (v) => (v > 0.3 ? 'richly saturated colors, slide film' : v > 0 ? 'slightly boosted color' : v < -0.6 ? 'nearly monochrome, desaturated' : 'muted desaturated colors') },
  { id: 'warmth', group: 'color', label: 'Warmth', term: 'color temperature · white balance', min: -1, max: 1, step: 0.01, def: 0,
    hint: 'Blue to amber. Tungsten light under daylight balance reads warm; the reverse reads cold.',
    words: (v) => (v > 0 ? 'warm amber tungsten color temperature' : 'cool blue color temperature') },
  { id: 'tint', group: 'color', label: 'Tint', term: 'green–magenta tint', min: -1, max: 1, step: 0.01, def: 0,
    hint: 'The other white-balance axis. Green reads as fluorescent tubes or expired film; magenta as a faded Polaroid.',
    words: (v) => (v > 0 ? 'magenta tint' : 'green tint, fluorescent cast') },
  { id: 'shoulder', group: 'color', label: 'Highlight shoulder', term: 'film highlight roll-off', min: 0, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'Compresses bright tones smoothly while keeping their differences. Cannot recover clipped detail.',
    words: () => 'gentle photographic highlight roll-off' },
  { id: 'toe', group: 'color', label: 'Shadow toe', term: 'film shadow response', min: 0, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'Deepens low tones progressively while holding the black point; leaves midtones alone.',
    words: () => 'grounded photographic shadows' },
  { id: 'crossover', group: 'color', label: 'Film color response', term: 'dye crossover · print stock', min: -1, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'Film dyes respond differently through the tonal range. Positive gives cyan-green shadows and warm amber highlights like a cinema print; negative cools the highlights and warms the shadows like expired stock.',
    words: (v) => (v > 0 ? 'cinema print film color, teal-green shadows and warm amber highlights' : 'expired film color shift, warm shadows and cool highlights') },
  { id: 'highlightChroma', group: 'color', label: 'Highlight color restraint', term: 'negative highlight chroma', min: 0, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'Gently reduces saturation as tones approach white, preserving color in the shadows.',
    words: () => 'restrained highlight color' },
  { id: 'cast', group: 'color', label: 'Color cast', term: 'color cast · wash', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'A single color laid over everything, like shooting through a tinted window or under a sodium lamp.',
    words: () => 'overall color cast' },
  { id: 'castColor', group: 'color', label: 'Cast color', term: 'cast hue', type: 'color', def: '#b9c04a',
    hint: 'Yellow-green is the classic expired-film and fluorescent cast.' },
  { id: 'splitTone', group: 'color', label: 'Split tone', term: 'split toning · shadows/highlights', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Tints shadows one color and highlights another. Teal shadows with orange highlights is the cinema cliché for a reason.',
    words: () => 'split-toned, colored shadows and highlights' },
  { id: 'shadowColor', group: 'color', label: 'Shadow tone', term: 'shadow tint', type: 'color', def: '#1f4a46', hint: 'The color the darkest areas lean toward.' },
  { id: 'highlightColor', group: 'color', label: 'Highlight tone', term: 'highlight tint', type: 'color', def: '#ffb067', hint: 'The color the brightest areas lean toward.' },

  { id: 'grain', group: 'texture', label: 'Grain', term: 'film grain · ISO noise', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'The texture of fast film or a pushed stock. Strongest in the midtones, almost absent in pure black and white.',
    words: (v) => (v > 0.6 ? 'heavy film grain, high ISO, pushed film stock' : v > 0.3 ? 'visible film grain' : 'fine film grain') },
  { id: 'grainSize', group: 'texture', label: 'Grain size', term: 'grain structure · gauge', min: 0, max: 1, step: 0.01, def: 0.35, modifier: 'grain',
    hint: 'Fine grain reads as 35mm; coarse grain reads as Super 8 or a blown-up print.',
    words: (v) => (v > 0.6 ? 'coarse Super 8 grain' : v > 0.3 ? '16mm grain' : 'fine 35mm grain') },
  { id: 'grainColor', group: 'texture', label: 'Color grain', term: 'chroma noise', type: 'toggle', def: false,
    hint: 'Monochrome grain is film. Colored speckle is a sensor at high ISO or a Polaroid emulsion.' },
  { id: 'tracking', group: 'texture', label: 'Tracking', term: 'head-switching noise · dropouts', min: 0, max: 1, step: 0.01, def: 0, since: 2,
    hint: 'The torn strip along the bottom of a VHS frame and the odd white dropout streak where the tape lost its oxide.',
    words: () => 'VHS head-switching noise at the bottom of frame, tape dropouts' },
  { id: 'tapeNoise', group: 'texture', label: 'Tape noise', term: 'tape bands · tracking noise', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Faint horizontal bands of brightness noise, the texture of a worn videotape.',
    words: () => 'VHS tape noise, horizontal tracking bands' },

  { id: 'vignette', group: 'frame', label: 'Vignette', term: 'vignette · lens falloff', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'The corners darken, as a wide-open vintage lens or a lens hood does.',
    words: (v) => (v > 0.5 ? 'heavy vignette, dark corners' : 'soft vignette') },
  { id: 'leak', group: 'frame', label: 'Light leak', term: 'light leak · fogging', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Light sneaking into the camera body fogs one side of the frame; on video it drifts slowly.',
    words: () => 'light leak, fogged edge of frame' },
  { id: 'leakColor', group: 'frame', label: 'Leak color', term: 'leak hue', type: 'color', def: '#ff7a2a', hint: 'Real leaks are orange-red, from light through the film base.' },
  { id: 'weave', group: 'motion', label: 'Gate weave', term: 'gate weave · frame jitter', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'The frame drifts a few pixels as film shuffles through the projector gate. Stills ignore it.',
    words: () => 'projected film gate weave, slight frame jitter' },
  // Rates only reshape time: every value is a function of the song frame, so a
  // slower or faster drift never moves a shot or the audio. 1 is the original speed.
  { id: 'weaveRate', group: 'motion', label: 'Weave speed', term: 'weave rate', min: 0.25, max: 3, step: 0.05, def: 1, modifier: 'weave',
    hint: 'How fast the frame drifts. Slow reads as a loose home projector; fast as a hand-cranked camera.' },
  { id: 'flicker', group: 'motion', label: 'Flicker', term: 'projector flicker · exposure flicker', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Frame-to-frame brightness wobble of a projector or a hand-cranked camera. Stills ignore it.',
    words: () => 'flickering projector exposure' },
  { id: 'flickerRate', group: 'motion', label: 'Flicker speed', term: 'flicker rate', min: 0.1, max: 1, step: 0.05, def: 1, modifier: 'flicker',
    hint: 'How often the exposure changes. Full speed changes every frame; lower glides between changes like a slow projector lamp.' },
]);

export const FILM_LOOK_CONTROL_IDS = Object.freeze(FILM_LOOK_CONTROLS.map((control) => control.id));
const CONTROL_BY_ID = new Map(FILM_LOOK_CONTROLS.map((control) => [control.id, control]));

// Named starting points. Each lists only what differs from the defaults; the
// first non-neutral one is the look Adam's 1980s reference reads as.
export const FILM_LOOK_PRESETS = Object.freeze([
  { id: 'none', label: 'Clean', summary: 'No finishing; the picture as rendered.', values: {} },
  { id: 'neon-rain', label: 'Neon rain 80s', summary: 'Yellow-green cast, red-orange halation, missed focus, heavy grain, crushed shadows, faded contrast.',
    values: { defocus: 0.3, diffusion: 0.25, halation: 0.8, chroma: 0.25, bleed: 0.35, contrast: -0.2, fade: 0.3, saturation: 0.15, warmth: 0.2, tint: -0.15, cast: 0.2, castColor: '#b9c04a', splitTone: 0.35, shadowColor: '#163a2e', highlightColor: '#ffa060', grain: 0.6, grainSize: 0.45, vignette: 0.35 } },
  { id: 'cinematic-analog', label: 'Cinematic analog', summary: 'Warm amber skin, teal-green shadows, wide halation round the lights, soft grain and a vintage lens falling off at the edges.',
    values: { version: 2, defocus: 0.06, diffusion: 0.18, halation: 0.55, halationSpread: 0.55, edgeSoftness: 0.55, crossover: 0.85, toe: 0.35, shoulder: 0.6, highlightChroma: 0.2, fade: 0.12, contrast: 0.08, saturation: 0.12, warmth: 0.22, tint: -0.12, splitTone: 0.28, shadowColor: '#1d4a44', highlightColor: '#ffb067', grain: 0.38, grainSize: 0.3, vignette: 0.35 } },
  { id: 'tungsten-night', label: 'Tungsten night', summary: 'Night film balanced for lamps: red halos round every light, cool shadows, visible grain.',
    values: { version: 2, diffusion: 0.1, halation: 0.75, halationSpread: 0.35, halationColor: '#ff3a1a', crossover: 0.5, toe: 0.3, shoulder: 0.5, fade: 0.08, saturation: 0.08, warmth: -0.12, tint: -0.04, splitTone: 0.2, shadowColor: '#12404a', highlightColor: '#ffb067', grain: 0.35, grainSize: 0.32, vignette: 0.2 } },
  { id: 'pastel-portrait', label: 'Pastel portrait', summary: 'Portrait negative: soft highlights, gentle warm skin, quiet pastel color and fine grain.',
    values: { version: 2, diffusion: 0.12, halation: 0.12, crossover: 0.25, shoulder: 0.7, toe: 0.1, highlightChroma: 0.35, fade: 0.15, contrast: -0.08, saturation: -0.08, warmth: 0.12, tint: 0.05, grain: 0.2, grainSize: 0.2, vignette: 0.12 } },
  { id: 'polaroid', label: 'Polaroid', summary: 'Instant film: creamy highlights, cyan-leaning shadows, soft corners and a warm leak fogging the edge.',
    values: { version: 2, defocus: 0.12, diffusion: 0.2, halation: 0.2, halationSpread: 0.4, edgeSoftness: 0.3, crossover: 0.5, toe: 0.3, shoulder: 0.5, highlightChroma: 0.3, contrast: 0.12, fade: 0.15, warmth: 0.2, tint: 0.08, grain: 0.25, grainSize: 0.3, grainColor: true, vignette: 0.4, leak: 0.7 } },
  { id: 'vhs', label: 'VHS', summary: 'Sideways smear and color bleed, a torn tracking strip along the bottom, dropouts and faint chroma noise.',
    values: { version: 2, smear: 0.6, bleed: 0.65, chroma: 0.15, diffusion: 0.15, contrast: -0.05, fade: 0.12, saturation: 0.05, tint: 0.06, grain: 0.12, grainSize: 0.15, grainColor: true, tracking: 0.3, tapeNoise: 0.08, vignette: 0.1 } },
  { id: 'super8', label: 'Super 8', summary: 'Coarse grain, warm faded color, gate weave and projector flicker.',
    values: { defocus: 0.15, halation: 0.35, contrast: -0.1, fade: 0.25, saturation: 0.1, warmth: 0.35, grain: 0.75, grainSize: 0.7, vignette: 0.5, leak: 0.2, weave: 0.6, flicker: 0.4 } },
  // Restrained on purpose: a slow, gentle weave and a breathing flicker, never a strobe.
  { id: 'home-movie', label: 'Home movie', summary: 'Old family film, gently: slow weave, a soft breathing flicker, warm faded color, coarse grain and a faint leak.',
    values: { defocus: 0.08, halation: 0.15, contrast: -0.06, fade: 0.22, saturation: -0.05, warmth: 0.25, grain: 0.4, grainSize: 0.6, vignette: 0.3, leak: 0.12, weave: 0.3, weaveRate: 0.6, flicker: 0.15, flickerRate: 0.5 } },
  { id: '16mm', label: '16mm', summary: 'Documentary film: visible grain, honest color, a gentle vignette.',
    values: { halation: 0.25, contrast: 0.05, fade: 0.1, saturation: -0.05, grain: 0.45, grainSize: 0.4, vignette: 0.25, weave: 0.15 } },
  { id: 'soft-analog', label: 'Soft analog', summary: 'A light hand: a little diffusion, fine grain, a touch of warmth.',
    values: { defocus: 0.1, diffusion: 0.2, halation: 0.15, fade: 0.1, warmth: 0.1, grain: 0.25, grainSize: 0.3, vignette: 0.15 } },
  { id: 'teal-orange', label: 'Teal & orange', summary: 'Modern cinema grade: teal shadows, orange skin, clean and contrasty.',
    values: { contrast: 0.15, saturation: 0.1, splitTone: 0.6, shadowColor: '#0f5a63', highlightColor: '#ff9a4a', grain: 0.12, grainSize: 0.2, vignette: 0.2 } },
  { id: 'newsprint', label: 'Monochrome', summary: 'Black and white with grain and a fade, like pushed Tri-X.',
    values: { contrast: 0.2, fade: 0.15, saturation: -1, grain: 0.55, grainSize: 0.45, vignette: 0.3 } },
  { id: 'natural-35mm', label: 'Natural 35mm', summary: 'Original photographic recipe: gentle highlights, grounded shadows, fine grain and restrained local glow.',
    values: { version: 2, shoulder: 0.5, toe: 0.2, highlightChroma: 0.35, saturation: -0.04, warmth: 0.03, halation: 0.1, grain: 0.18, grainSize: 0.15, vignette: 0.06 } },
  { id: 'warm-negative', label: 'Warm consumer negative', summary: 'Original warm photographic recipe with soft highlights and a little more grain.',
    values: { version: 2, shoulder: 0.6, toe: 0.15, highlightChroma: 0.45, warmth: 0.18, saturation: -0.03, halation: 0.13, grain: 0.24, grainSize: 0.22, vignette: 0.1 } },
  { id: 'cinema-negative', label: 'Restrained cinema negative', summary: 'Original cinema recipe: deeper shadows, controlled highlights and quiet color.',
    values: { version: 2, shoulder: 0.65, toe: 0.45, highlightChroma: 0.4, saturation: -0.08, warmth: -0.02, halation: 0.08, grain: 0.15, grainSize: 0.13, vignette: 0.08 } },
]);

export const FILM_LOOK_PRESET_IDS = Object.freeze(FILM_LOOK_PRESETS.map((preset) => preset.id));

const HEX = /^#[0-9a-f]{6}$/i;
const clampNumber = (value, control) => Math.min(control.max, Math.max(control.min, Math.round(value / control.step) * control.step));

/** The look a preset id names, with every control filled in. */
export function filmLookPreset(id) {
  const preset = FILM_LOOK_PRESETS.find((entry) => entry.id === id) || FILM_LOOK_PRESETS[0];
  return normalizeFilmLook({ preset: preset.id, ...preset.values });
}

/**
 * A complete, bounded look from any input: unknown keys dropped, numbers
 * clamped to their control's range, colors as `#rrggbb`, toggles as booleans.
 * Returns null for a non-object (a project without a look).
 */
export function normalizeFilmLook(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.version !== undefined && input.version !== 1 && input.version !== 2) return null;
  const version = input.version === 2 || FILM_LOOK_CONTROLS.some((c) => c.since === 2 && Math.abs(Number(input[c.id])) > 0) ? 2 : FILM_LOOK_VERSION;
  const look = { version, preset: FILM_LOOK_PRESET_IDS.includes(input.preset) ? input.preset : 'custom' };
  for (const control of FILM_LOOK_CONTROLS) {
    const value = input[control.id];
    if (control.type === 'color') look[control.id] = typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : control.def;
    else if (control.type === 'toggle') look[control.id] = typeof value === 'boolean' ? value : control.def;
    else look[control.id] = Number.isFinite(value) ? Number(clampNumber(value, control).toFixed(4)) : control.def;
  }
  return look;
}

/** True when the look changes nothing (every effect at zero), so a render can skip it. */
export function isFilmLookNeutral(look) {
  const settings = normalizeFilmLook(look);
  if (!settings) return true;
  // Colors and toggles only shape an effect; a modifier (grain size) only matters while its effect is on.
  return FILM_LOOK_CONTROLS.every((control) => control.type || control.modifier || settings[control.id] === 0);
}

/**
 * The look in prompt language: the vocabulary a user pastes into an image or
 * video prompt to ask for the same qualities at generation time. Lists only the
 * effects that are on, strongest first.
 */
export function describeFilmLook(look) {
  const settings = normalizeFilmLook(look);
  if (!settings) return '';
  const phrases = FILM_LOOK_CONTROLS
    .filter((control) => !control.type && control.words && Math.abs(settings[control.id]) >= 0.08
      && (!control.modifier || Math.abs(settings[control.modifier]) >= 0.08))
    .sort((a, b) => Math.abs(settings[b.id]) - Math.abs(settings[a.id]))
    .map((control) => control.words(settings[control.id]));
  if (settings.grainColor && settings.grain >= 0.08) phrases.splice(1, 0, 'colored noise speckle');
  // The strongest eight read as direction; a longer list reads as noise.
  return [...new Set(phrases)].slice(0, 8).join(', ');
}

/**
 * The look at a fraction of its strength: every effect scaled toward zero (1 =
 * as given, 0 = clean). Modifiers, colors and toggles only shape an effect, so
 * they keep their values.
 */
export function scaleFilmLook(look, amount) {
  const settings = normalizeFilmLook(look);
  if (!settings) return null;
  const k = Math.min(1, Math.max(0, Number(amount) || 0));
  const scaled = { ...settings };
  for (const control of FILM_LOOK_CONTROLS) {
    if (!control.type && !control.modifier) scaled[control.id] = settings[control.id] * k;
  }
  return normalizeFilmLook(scaled);
}

/** True when two looks set every control the same (their preset names aside). */
export function sameFilmLook(a, b) {
  const left = normalizeFilmLook(a);
  const right = normalizeFilmLook(b);
  if (!left || !right) return left === right;
  return left.version === right.version && FILM_LOOK_CONTROLS.every((control) => left[control.id] === right[control.id]);
}

/** The control record for an id (label, term, hint, range). */
export const filmLookControl = (id) => CONTROL_BY_ID.get(id) || null;

/**
 * The SVG `<filter>` for a look at one frame, in a `<svg>` element sized to
 * nothing, plus the CSS filter reference that applies it. `width`/`height` are
 * the CSS pixel size of the element being filtered: every radius and offset is a
 * fraction of them, so the same look reads the same on a phone preview, the
 * 1920-wide render and a 4K still.
 *
 * SELF-CONTAINED by contract (inlined into sandboxed pages via toString()).
 * `look` is a normalized look; missing values read as their neutral.
 */
export function filmLookFilterMarkup(look, { frame = 0, width = 1920, height = 1080, id = 'portos-film-look' } = {}) {
  const v = (key, neutral = 0) => (look && Number.isFinite(look[key]) ? look[key] : neutral);
  const hex = (key, fallback) => (look && typeof look[key] === 'string' && /^#[0-9a-f]{6}$/i.test(look[key]) ? look[key] : fallback);
  const rgb = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const n = (value) => Number(value.toFixed(4));
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const f = Math.max(0, Math.floor(frame));
  // Integer hash → [0, 1): the same frame hashes the same in every browser.
  const hash = (seed) => {
    let x = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) >>> 0;
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const LUMA = '0.2126 0.7152 0.0722';
  const lumaRgb = `${LUMA} 0 0 ${LUMA} 0 0 ${LUMA} 0 0 0 0 0 1 0`;
  const parts = [];
  let cur = 'SourceGraphic';
  let step = 0;
  const next = () => `s${step++}`;
  const emit = (markup, name = next()) => { parts.push(markup.replace('result=""', `result="${name}"`)); cur = name; return name; };

  // Opaque base: letterbox and transparent areas blend as black, so every
  // arithmetic step below works on alpha 1 and the edges stay clean.
  emit('<feFlood flood-color="#000" result=""/>', 'bg');
  if (look?.version === 2) emit('<feComponentTransfer in="SourceGraphic" result=""><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>');
  else emit(`<feComposite in="SourceGraphic" in2="bg" operator="over" result=""/>`);

  // Version 1 stays byte-for-byte identical. The new curve is evaluated before
  // glow so optical effects cannot clip the source before its shoulder acts.
  if (look?.version === 2 && (v('shoulder') || v('toe') || v('crossover'))) {
    const curve = (x) => {
      if (x < 0.25) return x * (1 - v('toe') * 0.6 * (1 - x / 0.25) ** 2);
      if (x <= 0.55) return x;
      const t = (x - 0.55) / 0.45;
      return 0.55 + 0.45 * t / (1 + v('shoulder') * 0.8 * t);
    };
    // Dye crossover: each channel bends away from the shared curve in opposite
    // directions below and above middle gray (zero at black, gray and white), so
    // shadows lean cyan-green and highlights amber without moving the end points.
    const lean = { R: 0.13, G: -0.045, B: -0.15 };
    const tables = ['R', 'G', 'B'].map((c) => Array.from({ length: 256 }, (_, i) => {
      const x = i / 255;
      const y = curve(x) + v('crossover') * lean[c] * (2 * x - 1) * 4 * x * (1 - x);
      return n(Math.min(1, Math.max(0, y)));
    }).join(' '));
    emit(`<feComponentTransfer in="${cur}" result="">${['R', 'G', 'B'].map((c, i) => `<feFunc${c} type="table" tableValues="${tables[i]}"/>`).join('')}</feComponentTransfer>`);
  }
  if (look?.version === 2 && v('highlightChroma')) {
    const pic = cur;
    const mask = emit(`<feColorMatrix in="${pic}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${LUMA} 0 0" result=""/>`);
    const neutral = emit(`<feColorMatrix in="${pic}" type="saturate" values="${n(1 - 0.65 * v('highlightChroma'))}" result=""/>`);
    const local = emit(`<feComposite in="${neutral}" in2="${mask}" operator="in" result=""/>`);
    emit(`<feComposite in="${local}" in2="${pic}" operator="over" result=""/>`);
  }

  const weave = v('weave');
  if (weave > 0) {
    // A rate of 1 is the original drift, byte for byte.
    const p = f * v('weaveRate', 1);
    const dx = weave * 0.004 * w * (Math.sin(p * 0.37) + 0.6 * Math.sin(p * 1.13)) / 1.6;
    const dy = weave * 0.004 * h * (Math.cos(p * 0.29) + 0.6 * Math.sin(p * 0.91)) / 1.6;
    emit(`<feOffset in="${cur}" dx="${n(dx)}" dy="${n(dy)}" result=""/>`);
  }
  const defocus = v('defocus');
  if (defocus > 0) emit(`<feGaussianBlur in="${cur}" stdDeviation="${n(Math.pow(defocus, 1.5) * 0.014 * w)}" edgeMode="duplicate" result=""/>`);
  const edgeSoftness = v('edgeSoftness');
  if (edgeSoftness > 0) {
    // Sharp center, blurred rim: picture × mask + blur × (1 − mask), the mask a soft-edged lit rectangle.
    const pic = cur;
    const blurred = emit(`<feGaussianBlur in="${pic}" stdDeviation="${n((0.001 + 0.006 * edgeSoftness) * w)}" edgeMode="duplicate" result=""/>`);
    const inset = 0.1 + 0.16 * edgeSoftness;
    const lit = emit(`<feFlood flood-color="#fff" x="${n(w * inset)}" y="${n(h * inset)}" width="${n(w * (1 - 2 * inset))}" height="${n(h * (1 - 2 * inset))}" result=""/>`);
    const mask = emit(`<feGaussianBlur in="${lit}" stdDeviation="${n(0.09 * w)}" x="0" y="0" width="${n(w)}" height="${n(h)}" result=""/>`);
    const sharp = emit(`<feComposite in="${pic}" in2="${mask}" operator="in" result=""/>`);
    const rim = emit(`<feComposite in="${blurred}" in2="${mask}" operator="arithmetic" k1="-1" k2="1" k3="0" k4="0" result=""/>`);
    emit(`<feComposite in="${sharp}" in2="${rim}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result=""/>`);
  }
  const smear = v('smear');
  if (smear > 0) emit(`<feGaussianBlur in="${cur}" stdDeviation="${n(smear * 0.0045 * w)} 0" edgeMode="duplicate" result=""/>`);

  const bleed = v('bleed');
  if (bleed > 0) {
    const pic = cur;
    const blurred = emit(`<feGaussianBlur in="${pic}" stdDeviation="${n(bleed * 0.02 * w)} 0" edgeMode="duplicate" result=""/>`);
    const lumaPic = emit(`<feColorMatrix in="${pic}" type="matrix" values="${lumaRgb}" result=""/>`);
    const lumaBlur = emit(`<feColorMatrix in="${blurred}" type="matrix" values="${lumaRgb}" result=""/>`);
    // Blurred color, original brightness: d = 0.5 + (blur − lumaBlur)/2, then lumaPic + 2d − 1.
    const d = emit(`<feComposite in="${blurred}" in2="${lumaBlur}" operator="arithmetic" k1="0" k2="0.5" k3="-0.5" k4="0.5" result=""/>`);
    emit(`<feComposite in="${lumaPic}" in2="${d}" operator="arithmetic" k1="0" k2="1" k3="2" k4="-1" result=""/>`);
  }
  const chroma = v('chroma');
  if (chroma > 0) {
    const pic = cur;
    const shift = n(chroma * 0.004 * w);
    const r = emit(`<feColorMatrix in="${pic}" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result=""/>`);
    const rs = emit(`<feOffset in="${r}" dx="${shift}" dy="0" result=""/>`);
    const g = emit(`<feColorMatrix in="${pic}" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result=""/>`);
    const b = emit(`<feColorMatrix in="${pic}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result=""/>`);
    const bs = emit(`<feOffset in="${b}" dx="-${shift}" dy="0" result=""/>`);
    const rg = emit(`<feComposite in="${rs}" in2="${g}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result=""/>`);
    emit(`<feComposite in="${rg}" in2="${bs}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result=""/>`);
  }
  const diffusion = v('diffusion');
  if (diffusion > 0) {
    const pic = cur;
    const glow = emit(`<feGaussianBlur in="${pic}" stdDeviation="${n((0.01 + 0.02 * diffusion) * w)}" edgeMode="duplicate" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${glow}" operator="arithmetic" k1="0" k2="${n(1 - 0.25 * diffusion)}" k3="${n(0.55 * diffusion)}" k4="0" result=""/>`);
  }
  const halation = v('halation');
  if (halation > 0) {
    const pic = cur;
    const [hr, hg, hb] = rgb(hex('halationColor', '#ff5a1f'));
    const luma = emit(`<feColorMatrix in="${pic}" type="matrix" values="${lumaRgb}" result=""/>`);
    const bright = emit(`<feComponentTransfer in="${luma}" result=""><feFuncR type="linear" slope="2.5" intercept="-1.5"/><feFuncG type="linear" slope="2.5" intercept="-1.5"/><feFuncB type="linear" slope="2.5" intercept="-1.5"/></feComponentTransfer>`);
    const reach = v('halationSpread');
    const spread = emit(`<feGaussianBlur in="${bright}" stdDeviation="${n((look?.version === 2 ? 0.001 + 0.006 * halation + 0.03 * reach : 0.008 + 0.03 * halation) * w)}" edgeMode="duplicate" result=""/>`);
    const tinted = emit(`<feColorMatrix in="${spread}" type="matrix" values="${n(hr)} 0 0 0 0 0 ${n(hg)} 0 0 0 0 0 ${n(hb)} 0 0 0 0 0 1 0" result=""/>`);
    // A wider halo spreads the same light thinner; lift it so spread changes reach, not strength.
    emit(`<feComposite in="${pic}" in2="${tinted}" operator="arithmetic" k1="0" k2="1" k3="${n(1.3 * halation * (1 + 1.5 * reach))}" k4="0" result=""/>`);
  }

  // Tone: exposure, contrast, fade, flicker, warmth and tint fold into one
  // linear transfer per channel (v' = slope·v + intercept).
  const exposure = v('exposure');
  const contrast = v('contrast');
  const fade = v('fade');
  const flicker = v('flicker');
  const warmth = v('warmth');
  const tint = v('tint');
  if (exposure || contrast || fade || flicker || warmth || tint) {
    // Below full speed the exposure glides from one frame's random value to the next; at 1 it is the per-frame hash.
    const at = f * v('flickerRate', 1);
    const i = Math.floor(at);
    const wobble = hash(i) + (hash(i + 1) - hash(i)) * (at - i);
    const e = Math.pow(2, exposure) * (1 + flicker * 0.12 * (wobble * 2 - 1));
    const c = 1 + contrast * 0.8;
    const s = 1 - 0.28 * fade;
    const slope = e * c * s;
    const intercept = s * ((1 - c) / 2) + 0.2 * fade;
    const channel = { r: (1 + 0.18 * warmth) * (1 + 0.07 * tint), g: 1 - 0.15 * tint, b: (1 - 0.18 * warmth) * (1 + 0.07 * tint) };
    const fn = (name, scale) => `<feFunc${name} type="linear" slope="${n(slope * scale)}" intercept="${n(intercept * scale)}"/>`;
    emit(`<feComponentTransfer in="${cur}" result="">${fn('R', channel.r)}${fn('G', channel.g)}${fn('B', channel.b)}</feComponentTransfer>`);
  }
  const saturation = v('saturation');
  if (saturation) emit(`<feColorMatrix in="${cur}" type="saturate" values="${n(Math.max(0, 1 + saturation))}" result=""/>`);
  const cast = v('cast');
  if (cast > 0) {
    const pic = cur;
    const flood = emit(`<feFlood flood-color="${hex('castColor', '#b9c04a')}" result=""/>`);
    const blended = emit(`<feBlend in="${flood}" in2="${pic}" mode="soft-light" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${blended}" operator="arithmetic" k1="0" k2="${n(1 - cast)}" k3="${n(cast)}" k4="0" result=""/>`);
  }
  const split = v('splitTone');
  if (split > 0) {
    const pic = cur;
    const hiMask = emit(`<feColorMatrix in="${pic}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${LUMA} 0 0" result=""/>`);
    const loMask = emit(`<feColorMatrix in="${pic}" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -0.2126 -0.7152 -0.0722 0 1" result=""/>`);
    const hiFlood = emit(`<feFlood flood-color="${hex('highlightColor', '#ffb067')}" result=""/>`);
    const loFlood = emit(`<feFlood flood-color="${hex('shadowColor', '#1f4a46')}" result=""/>`);
    const hi = emit(`<feComposite in="${hiFlood}" in2="${hiMask}" operator="in" result=""/>`);
    const lo = emit(`<feComposite in="${loFlood}" in2="${loMask}" operator="in" result=""/>`);
    const withHi = emit(`<feBlend in="${hi}" in2="${pic}" mode="soft-light" result=""/>`);
    const withLo = emit(`<feBlend in="${lo}" in2="${withHi}" mode="soft-light" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${withLo}" operator="arithmetic" k1="0" k2="${n(1 - split)}" k3="${n(split)}" k4="0" result=""/>`);
  }

  const grain = v('grain');
  if (grain > 0) {
    const pic = cur;
    const size = v('grainSize', 0.35);
    // Grain features scale with the frame: the same look is as fine on a 4K still as in a phone preview.
    const base = Math.min(1.5, (0.95 - 0.7 * size) * (1920 / w));
    const noise = emit(`<feTurbulence type="fractalNoise" baseFrequency="${n(base)}" numOctaves="2" seed="${(f % 9973) + 1}" stitchTiles="noStitch" result=""/>`);
    const mono = look && look.grainColor === true
      ? emit(`<feColorMatrix in="${noise}" type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1" result=""/>`)
      : emit(`<feColorMatrix in="${noise}" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result=""/>`);
    const blended = emit(`<feBlend in="${mono}" in2="${pic}" mode="overlay" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${blended}" operator="arithmetic" k1="0" k2="${n(1 - grain)}" k3="${n(grain)}" k4="0" result=""/>`);
  }
  const tape = v('tapeNoise');
  if (tape > 0) {
    const pic = cur;
    const bands = emit(`<feTurbulence type="fractalNoise" baseFrequency="${n(0.0015 * (1920 / w))} ${n(0.45 * (1080 / h))}" numOctaves="1" seed="${((f * 7) % 9973) + 1}" result=""/>`);
    const mono = emit(`<feColorMatrix in="${bands}" type="matrix" values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result=""/>`);
    const blended = emit(`<feBlend in="${mono}" in2="${pic}" mode="soft-light" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${blended}" operator="arithmetic" k1="0" k2="${n(1 - 0.8 * tape)}" k3="${n(0.8 * tape)}" k4="0" result=""/>`);
  }
  const tracking = v('tracking');
  if (tracking > 0) {
    const pic = cur;
    // Dropouts: thin horizontal streaks where one row of the noise peaks, re-drawn every frame.
    const noise = emit(`<feTurbulence type="fractalNoise" baseFrequency="${n(0.004 * (1920 / w))} ${n(0.3 * (1080 / h))}" numOctaves="1" seed="${((f * 13) % 9973) + 1}" result=""/>`);
    const peaks = emit(`<feComponentTransfer in="${noise}" result=""><feFuncR type="linear" slope="14" intercept="${n(-14 * (0.74 - 0.04 * tracking))}"/></feComponentTransfer>`);
    const streaks = emit(`<feColorMatrix in="${peaks}" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 ${n(0.7 * tracking)} 0 0 0 0" result=""/>`);
    const dropped = emit(`<feComposite in="${streaks}" in2="${pic}" operator="over" result=""/>`);
    // Head switching: the bottom rows torn sideways and lifted, jumping a little every frame.
    const band = Math.max(1, (0.012 + 0.025 * tracking) * h);
    const jump = 0.6 + 0.4 * hash(f + 101);
    const torn = emit(`<feOffset in="${dropped}" dx="${n(tracking * 0.03 * w * jump)}" dy="0" x="0" y="${n(h - band)}" width="${n(w)}" height="${n(band)}" result=""/>`);
    const lifted = emit(`<feComponentTransfer in="${torn}" x="0" y="${n(h - band)}" width="${n(w)}" height="${n(band)}" result=""><feFuncR type="linear" slope="0.85" intercept="0.1"/><feFuncG type="linear" slope="0.85" intercept="0.1"/><feFuncB type="linear" slope="0.85" intercept="0.1"/></feComponentTransfer>`);
    emit(`<feComposite in="${lifted}" in2="${dropped}" operator="over" result=""/>`);
  }
  const vignette = v('vignette');
  if (vignette > 0) {
    const pic = cur;
    const inset = 0.08 + 0.1 * vignette;
    const lit = emit(`<feFlood flood-color="#fff" x="${n(w * inset)}" y="${n(h * inset)}" width="${n(w * (1 - 2 * inset))}" height="${n(h * (1 - 2 * inset))}" result=""/>`);
    // A primitive's region defaults to its input's, which would clip the blur to the lit rectangle; spread over the whole frame.
    const soft = emit(`<feGaussianBlur in="${lit}" stdDeviation="${n((0.06 + 0.06 * vignette) * w)}" x="0" y="0" width="${n(w)}" height="${n(h)}" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${soft}" operator="arithmetic" k1="${n(vignette)}" k2="${n(1 - vignette)}" k3="0" k4="0" result=""/>`);
  }
  const leak = v('leak');
  if (leak > 0) {
    const pic = cur;
    const drift = 0.62 + 0.18 * Math.sin(f * 0.011) + 0.05 * Math.sin(f * 0.047);
    const breathe = 0.75 + 0.25 * Math.sin(f * 0.023 + 1);
    if (look?.version === 2) {
      // Fogged from the film edge: a wide glow and a hotter, paler core pressed against the right side,
      // sliding up and down the edge as the frames advance.
      const color = hex('leakColor', '#ff7a2a');
      const core = `#${rgb(color).map((c) => Math.round(255 * (c + (1 - c) * 0.55)).toString(16).padStart(2, '0')).join('')}`;
      const top = h * (0.05 + 0.25 * (drift - 0.62) / 0.23);
      const glow = emit(`<feFlood flood-color="${color}" x="${n(w * 0.86)}" y="${n(top)}" width="${n(w * 0.4)}" height="${n(h * 0.8)}" result=""/>`);
      const wide = emit(`<feGaussianBlur in="${glow}" stdDeviation="${n(0.11 * w)}" x="0" y="0" width="${n(w)}" height="${n(h)}" result=""/>`);
      const hot = emit(`<feFlood flood-color="${core}" x="${n(w * 0.95)}" y="${n(top + h * 0.15)}" width="${n(w * 0.2)}" height="${n(h * 0.5)}" result=""/>`);
      const tight = emit(`<feGaussianBlur in="${hot}" stdDeviation="${n(0.05 * w)}" x="0" y="0" width="${n(w)}" height="${n(h)}" result=""/>`);
      const fog = emit(`<feBlend in="${tight}" in2="${wide}" mode="screen" result=""/>`);
      const faded = emit(`<feComponentTransfer in="${fog}" result=""><feFuncA type="linear" slope="${n(Math.min(1, 1.2 * leak * breathe))}" intercept="0"/></feComponentTransfer>`);
      emit(`<feBlend in="${faded}" in2="${pic}" mode="screen" result=""/>`);
    } else {
      const glow = emit(`<feFlood flood-color="${hex('leakColor', '#ff7a2a')}" x="${n(w * drift)}" y="${n(-h * 0.2)}" width="${n(w * 0.3)}" height="${n(h * 1.4)}" result=""/>`);
      const soft = emit(`<feGaussianBlur in="${glow}" stdDeviation="${n(0.09 * w)}" x="0" y="0" width="${n(w)}" height="${n(h)}" result=""/>`);
      const faded = emit(`<feComponentTransfer in="${soft}" result=""><feFuncA type="linear" slope="${n(leak * breathe)}" intercept="0"/></feComponentTransfer>`);
      emit(`<feBlend in="${faded}" in2="${pic}" mode="screen" result=""/>`);
    }
  }

  if (look?.version === 2 && parts.length > 2) emit(`<feComposite in="${cur}" in2="SourceGraphic" operator="in" result=""/>`);
  const filter = `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB" primitiveUnits="userSpaceOnUse">${parts.join('')}</filter>`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>${filter}</defs></svg>`,
    filter,
    css: `url(#${id})`,
    active: parts.length > 2,
  };
}

/**
 * The look as a PLAYING picture can afford it: no SVG filter, which a browser
 * re-runs over every decoded video frame (the full chain drops a phone's
 * animatic from 30 fps to under 1 after #11215), only what the
 * compositor does for free. The focus, tone and saturation become CSS filter
 * functions on the box holding the picture (`filter`, with the gate weave as
 * its `transform`), and the cast, grain, tape bands, vignette and leak become
 * blended `overlays` in the render's order, each a flat color, a gradient or a
 * tile rasterized once (`image`) and shifted per song frame (`shift`, [0, 1)).
 * The glows, the fringing, the split tone, the dye crossover, the lens fall-off
 * and the tracking strip have no cheap stand-in and are left to the exact filter
 * the paused picture shows; tape softness rides in the round CSS blur. Returns null for a
 * neutral look.
 */
export function filmLookMotionLayers(look, { frame = 0, width = 1920, height = 1080 } = {}) {
  const settings = normalizeFilmLook(look);
  if (!settings || isFilmLookNeutral(settings)) return null;
  return filmLookMotionMarkup(settings, { frame, width, height });
}

// Inlined into the page runtime; all dependencies stay inside this function.
function filmLookMotionMarkup(settings, { frame = 0, width = 1920, height = 1080 } = {}) {
  const FILM_LOOK_TILE_PX = 256;
  const svgDataUrl = (markup) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${markup}</svg>`)}`;
  const frameHash = (seed) => {
    let x = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) >>> 0;
    x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const hexColor = (value, fallback) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback);
  const v = (key) => (Number.isFinite(settings[key]) ? settings[key] : 0);
  const n = (value) => Number(value.toFixed(4));
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const f = Math.max(0, Math.floor(frame));
  const filter = [];
  const defocus = v('defocus');
  // CSS blur is round; tape softness rides in it at half strength, a sideways smear's nearest stand-in.
  const blur = Math.pow(defocus, 1.5) * 0.014 * w + v('smear') * 0.002 * w;
  if (blur > 0) filter.push(`blur(${n(blur)}px)`);
  // The render's per-channel transfer v' = slope·v + intercept, as brightness(b) then
  // contrast(k): k·b·v + (1 − k)/2, so k = 1 − 2·intercept and b = slope / k.
  const exposure = v('exposure'); const contrast = v('contrast'); const fade = v('fade'); const flicker = v('flicker');
  const rate = (key) => (Number.isFinite(settings[key]) ? settings[key] : 1);
  if (exposure || contrast || fade || flicker) {
    const at = f * rate('flickerRate');
    const i = Math.floor(at);
    const e = Math.pow(2, exposure) * (1 + flicker * 0.12 * ((frameHash(i) + (frameHash(i + 1) - frameHash(i)) * (at - i)) * 2 - 1));
    const c = 1 + contrast * 0.8;
    const s = 1 - 0.28 * fade;
    const slope = e * c * s;
    const intercept = s * ((1 - c) / 2) + 0.2 * fade;
    const k = Math.max(0.05, 1 - 2 * intercept);
    filter.push(`brightness(${n(slope / k)})`, `contrast(${n(k)})`);
  }
  const saturation = v('saturation');
  if (saturation) filter.push(`saturate(${n(Math.max(0, 1 + saturation))})`);
  const weave = v('weave');
  const p = f * rate('weaveRate');
  const transform = weave > 0
    ? `translate(${n(weave * 0.004 * w * (Math.sin(p * 0.37) + 0.6 * Math.sin(p * 1.13)) / 1.6)}px, ${n(weave * 0.004 * h * (Math.cos(p * 0.29) + 0.6 * Math.sin(p * 0.91)) / 1.6)}px)`
    : null;

  const overlays = [];
  const flat = (key, color, opacity, blend) => overlays.push({ key, kind: 'flat', color, opacity: n(opacity), blend });
  // Warmth and tint are per-channel scales in the render; a soft-light wash leans the picture the same way.
  const warmth = v('warmth');
  if (warmth) flat('warmth', warmth > 0 ? '#ff9a3c' : '#3c9aff', Math.min(1, Math.abs(warmth) * 0.9), 'soft-light');
  const tint = v('tint');
  if (tint) flat('tint', tint > 0 ? '#ff3cff' : '#3cff3c', Math.min(1, Math.abs(tint) * 0.6), 'soft-light');
  const cast = v('cast');
  if (cast > 0) flat('cast', hexColor(settings.castColor, '#b9c04a'), cast, 'soft-light');
  const mono = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1';
  const color = '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1';
  const grain = v('grain');
  if (grain > 0) {
    const size = Number.isFinite(settings.grainSize) ? settings.grainSize : 0.35;
    const baseFrequency = Math.min(1.5, (0.95 - 0.7 * size) * (1920 / w));
    const tile = FILM_LOOK_TILE_PX;
    overlays.push({
      key: 'grain', kind: 'tile', size: [tile, tile], opacity: n(grain), blend: 'overlay', shift: [n(frameHash(f)), n(frameHash(f + 1))],
      image: svgDataUrl(`width="${tile}" height="${tile}"><filter id="g" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="${n(baseFrequency)}" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix type="matrix" values="${settings.grainColor === true ? color : mono}"/></filter><rect width="${tile}" height="${tile}" filter="url(#g)"/>`),
    });
  }
  const tape = v('tapeNoise');
  if (tape > 0) {
    const tileW = Math.round(w);
    const tileH = 128;
    overlays.push({
      key: 'tape', kind: 'tile', size: [tileW, tileH], opacity: n(0.8 * tape), blend: 'soft-light', shift: [0, n(frameHash(f * 7))],
      image: svgDataUrl(`width="${tileW}" height="${tileH}"><filter id="t" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="${n(0.0015 * (1920 / w))} ${n(0.45 * (1080 / h))}" numOctaves="1" seed="11" stitchTiles="stitch"/><feColorMatrix type="matrix" values="${mono}"/></filter><rect width="${tileW}" height="${tileH}" filter="url(#t)"/>`),
    });
  }
  const vignette = v('vignette');
  if (vignette > 0) {
    overlays.push({ key: 'vignette', kind: 'gradient', opacity: 1, blend: 'normal',
      gradient: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(58 - 22 * vignette)}%, rgba(0,0,0,${n(vignette)}) 100%)` });
  }
  const leak = v('leak');
  if (leak > 0) {
    const drift = 0.62 + 0.18 * Math.sin(f * 0.011) + 0.05 * Math.sin(f * 0.047);
    const breathe = 0.75 + 0.25 * Math.sin(f * 0.023 + 1);
    const color = hexColor(settings.leakColor, '#ff7a2a');
    overlays.push(settings.version === 2
      ? { key: 'leak', kind: 'gradient', opacity: n(Math.min(1, 1.2 * leak * breathe)), blend: 'screen',
        gradient: `radial-gradient(ellipse 35% 60% at 100% ${n((0.45 + 0.25 * (drift - 0.62) / 0.23) * 100)}%, ${color} 0%, rgba(0,0,0,0) 75%)` }
      : { key: 'leak', kind: 'gradient', opacity: n(Math.min(1, leak * breathe)), blend: 'screen',
        gradient: `radial-gradient(ellipse 40% 140% at ${n((drift + 0.15) * 100)}% 50%, ${color} 0%, rgba(0,0,0,0) 70%)` });
  }
  return { filter: filter.join(' ') || null, transform, overlays };
}

/**
 * A browser script that applies a look to the page it runs in, re-seeding it
 * for every song frame: installed in the composition live preview and in the
 * final render's browser (`Page.addScriptToEvaluateOnNewDocument`) before the
 * document's own scripts. It exposes `window.__portosFilmLook`:
 *
 *   apply(look)   put a (normalized) look on the page, or null to clear it
 *   frame(n)      redraw for song frame n (grain, weave, flicker, leak)
 *   playback(on)  use cheap motion layers while a live preview plays; exact by default
 *   look          the look currently applied
 *
 * `globalThis.portosComposition` is intercepted when the document assigns it so
 * its `seek(t)` sets the frame BEFORE the document paints; the document's own
 * paint wait then covers the filter, and a seek stays one paint. The filter sits
 * on the root element, so it covers every layer the document draws.
 */
export function filmLookRuntimeSource(look = null) {
  return `(() => {
  const markup = ${filmLookFilterMarkup.toString()};
  const motion = ${filmLookMotionMarkup.toString()};
  const ID = 'portos-film-look';
  let look = ${JSON.stringify(normalizeFilmLook(look))};
  let frame = 0;
  let fps = 24;
  let host = null;
  let overlays = null;
  let playing = false;
  let savedTransform = null;
  const clearMotion = (root) => {
    if (overlays) { overlays.remove(); overlays = null; }
    if (savedTransform !== null) { root.style.transform = savedTransform; savedTransform = null; }
  };
  const paintTile = (el, layer, size) => {
    const key = layer.image + ':' + size.width + ':' + size.height;
    if (el._filmLookTileKey === key) return;
    el._filmLookTileKey = key;
    // Rasterize our own SVG filter directly into canvas once. Image URLs are
    // forbidden by the worker's code-only CSP; no image permission is needed.
    const id = 'portos-film-look-tile-' + layer.key;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    svg.innerHTML = decodeURIComponent(layer.image.slice(layer.image.indexOf(',') + 1))
      .replace(/id="[gt]"/g, 'id="' + id + '"').replace(/url\\(#(?:g|t)\\)/g, 'url(#' + id + ')');
    document.documentElement.appendChild(svg);
    const tile = document.createElement('canvas');
    [tile.width, tile.height] = layer.size;
    const context = tile.getContext('2d');
    context.filter = 'url(#' + id + ')';
    context.fillRect(0, 0, tile.width, tile.height);
    context.filter = 'none';
    svg.remove();
    const canvas = el._filmLookCanvas || document.createElement('canvas');
    canvas.width = Math.ceil(size.width * 2); canvas.height = Math.ceil(size.height * 2);
    canvas.style.cssText = 'width:200%;height:200%;pointer-events:none';
    const paint = canvas.getContext('2d');
    paint.fillStyle = paint.createPattern(tile, 'repeat');
    paint.fillRect(0, 0, canvas.width, canvas.height);
    if (!el._filmLookCanvas) el.appendChild(canvas);
    el._filmLookCanvas = canvas;
  };
  const drawMotion = (root, size) => {
    if (host) { host.remove(); host = null; }
    const built = motion(look, size);
    root.style.filter = built.filter || '';
    if (savedTransform === null) savedTransform = root.style.transform;
    root.style.transform = [savedTransform, built.transform].filter(Boolean).join(' ');
    if (!overlays) {
      overlays = document.createElement('div');
      overlays.dataset.portosFilmLookMotion = '1';
      overlays.setAttribute('aria-hidden', 'true');
      // A stacking context here would make blends see only the overlay group.
      overlays.style.cssText = 'display:contents;pointer-events:none';
    }
    // A root child after body also paints after max-z-index lyrics/title layers.
    if (root.lastElementChild !== overlays) root.appendChild(overlays);
    const keys = new Set(built.overlays.map((layer) => layer.key));
    for (const child of [...overlays.children]) if (!keys.has(child.dataset.filmLookLayer)) child.remove();
    for (const [index, layer] of built.overlays.entries()) {
      let el = [...overlays.children].find((child) => child.dataset.filmLookLayer === layer.key);
      if (!el) { el = document.createElement('div'); el.dataset.filmLookLayer = layer.key; }
      // Each layer blends with the document and all preceding film layers.
      el.style.position = 'fixed'; el.style.pointerEvents = 'none'; el.style.overflow = 'hidden';
      el.style.opacity = layer.opacity; el.style.mixBlendMode = layer.blend;
      el.style.left = '0'; el.style.top = '0';
      el.style.width = '100%'; el.style.height = '100%';
      if (layer.kind === 'flat') el.style.backgroundColor = layer.color;
      if (layer.kind === 'gradient') el.style.backgroundImage = layer.gradient;
      if (layer.kind === 'tile') {
        paintTile(el, layer, size);
        el._filmLookCanvas.style.transform = 'translate(' + (-layer.shift[0] * 50) + '%, ' + (-layer.shift[1] * 50) + '%)';
      }
      el.style.zIndex = '2147483647';
      // A slider can add an earlier layer after later ones already exist.
      if (overlays.children[index] !== el) overlays.insertBefore(el, overlays.children[index] || null);
    }
  };
  const draw = () => {
    const root = document.documentElement;
    if (!root) return;
    const size = { frame, width: root.clientWidth || innerWidth || 1920, height: root.clientHeight || innerHeight || 1080, id: ID };
    if (playing && look) { drawMotion(root, size); return; }
    clearMotion(root);
    const built = look ? markup(look, size) : null;
    if (!built || !built.active) {
      if (host) { host.remove(); host = null; }
      root.style.filter = '';
      return;
    }
    if (!host) {
      host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      host.setAttribute('width', '0'); host.setAttribute('height', '0'); host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      host.dataset.portosFilmLook = '1';
      (document.body || root).appendChild(host);
    } else if (!host.isConnected) (document.body || root).appendChild(host);
    host.innerHTML = '<defs>' + built.filter + '</defs>';
    if (root.style.filter !== built.css) root.style.filter = built.css;
  };
  const api = {
    apply(next) { look = next && typeof next === 'object' ? next : null; draw(); },
    playback(value) { const next = value === true; if (next !== playing) { playing = next; draw(); } },
    frame(n) { const next = Math.max(0, Math.floor(Number(n) || 0)); if (next !== frame || (!host && !overlays)) { frame = next; if (look) draw(); } },
    get look() { return look; },
  };
  Object.defineProperty(window, '__portosFilmLook', { value: api, configurable: false, writable: false });
  // Wrap the document's seek so the filter is re-seeded for the frame before the document paints it.
  let composition;
  const wrap = (c) => {
    if (!c || typeof c !== 'object' || typeof c.seek !== 'function' || c.__portosFilmLookWrapped) return c;
    const seek = c.seek;
    const wrapped = function(t, ...rest) {
      fps = Number(c.fps) > 0 ? Number(c.fps) : fps;
      api.frame(Math.round((Number(t) || 0) * fps));
      return seek.call(this, t, ...rest);
    };
    try { Object.defineProperty(c, 'seek', { value: wrapped, configurable: true, writable: true }); Object.defineProperty(c, '__portosFilmLookWrapped', { value: true }); }
    catch { return Object.assign(Object.create(c), { seek: wrapped, __portosFilmLookWrapped: true }); }
    return c;
  };
  Object.defineProperty(globalThis, 'portosComposition', { configurable: true, enumerable: true,
    get() { return composition; }, set(value) { composition = wrap(value); } });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', draw, { once: true }); else draw();
  addEventListener('resize', () => { if (look) draw(); });
})();`;
}
