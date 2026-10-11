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
  { id: 'frame', label: 'Frame & motion' },
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
  { id: 'halationColor', group: 'focus', label: 'Halation color', term: 'halation tint', type: 'color', def: '#ff5a1f',
    hint: 'Film halation is red-orange (the anti-halation layer passes red). Change it for a stylized glow.' },
  { id: 'chroma', group: 'focus', label: 'Color fringing', term: 'chromatic aberration', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'A cheap lens focuses red and blue at different points: colored fringes at edges, strongest off-center.',
    words: () => 'chromatic aberration, color fringing at edges, cheap lens' },
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
  { id: 'weave', group: 'frame', label: 'Gate weave', term: 'gate weave · frame jitter', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'The frame drifts a few pixels as film shuffles through the projector gate. Stills ignore it.',
    words: () => 'projected film gate weave, slight frame jitter' },
  { id: 'flicker', group: 'frame', label: 'Flicker', term: 'projector flicker · exposure flicker', min: 0, max: 1, step: 0.01, def: 0,
    hint: 'Frame-to-frame brightness wobble of a projector or a hand-cranked camera. Stills ignore it.',
    words: () => 'flickering projector exposure' },
]);

export const FILM_LOOK_CONTROL_IDS = Object.freeze(FILM_LOOK_CONTROLS.map((control) => control.id));
const CONTROL_BY_ID = new Map(FILM_LOOK_CONTROLS.map((control) => [control.id, control]));

// Named starting points. Each lists only what differs from the defaults; the
// first non-neutral one is the look Adam's 1980s reference reads as.
export const FILM_LOOK_PRESETS = Object.freeze([
  { id: 'none', label: 'Clean', summary: 'No finishing; the picture as rendered.', values: {} },
  { id: 'neon-rain', label: 'Neon rain 80s', summary: 'Yellow-green cast, red-orange halation, missed focus, heavy grain, crushed shadows, faded contrast.',
    values: { defocus: 0.3, diffusion: 0.25, halation: 0.8, chroma: 0.25, bleed: 0.35, contrast: -0.2, fade: 0.3, saturation: 0.15, warmth: 0.2, tint: -0.15, cast: 0.2, castColor: '#b9c04a', splitTone: 0.35, shadowColor: '#163a2e', highlightColor: '#ffa060', grain: 0.6, grainSize: 0.45, vignette: 0.35 } },
  { id: 'polaroid', label: 'Polaroid', summary: 'Soft, warm, faded instant film with a milky lift and fine color speckle.',
    values: { defocus: 0.2, diffusion: 0.3, halation: 0.2, contrast: -0.3, fade: 0.45, saturation: -0.15, warmth: 0.3, tint: 0.15, cast: 0.15, castColor: '#e8c48a', grain: 0.3, grainSize: 0.3, grainColor: true, vignette: 0.45 } },
  { id: 'vhs', label: 'VHS', summary: 'Smeared color, soft detail, tape bands and a slow drifting leak.',
    values: { defocus: 0.35, bleed: 0.8, chroma: 0.4, contrast: -0.1, saturation: 0.1, grain: 0.25, grainSize: 0.2, grainColor: true, tapeNoise: 0.5, vignette: 0.15, weave: 0.2, flicker: 0.15 } },
  { id: 'super8', label: 'Super 8', summary: 'Coarse grain, warm faded color, gate weave and projector flicker.',
    values: { defocus: 0.15, halation: 0.35, contrast: -0.1, fade: 0.25, saturation: 0.1, warmth: 0.35, grain: 0.75, grainSize: 0.7, vignette: 0.5, leak: 0.2, weave: 0.6, flicker: 0.4 } },
  { id: '16mm', label: '16mm', summary: 'Documentary film: visible grain, honest color, a gentle vignette.',
    values: { halation: 0.25, contrast: 0.05, fade: 0.1, saturation: -0.05, grain: 0.45, grainSize: 0.4, vignette: 0.25, weave: 0.15 } },
  { id: 'soft-analog', label: 'Soft analog', summary: 'A light hand: a little diffusion, fine grain, a touch of warmth.',
    values: { defocus: 0.1, diffusion: 0.2, halation: 0.15, fade: 0.1, warmth: 0.1, grain: 0.25, grainSize: 0.3, vignette: 0.15 } },
  { id: 'teal-orange', label: 'Teal & orange', summary: 'Modern cinema grade: teal shadows, orange skin, clean and contrasty.',
    values: { contrast: 0.15, saturation: 0.1, splitTone: 0.6, shadowColor: '#0f5a63', highlightColor: '#ff9a4a', grain: 0.12, grainSize: 0.2, vignette: 0.2 } },
  { id: 'newsprint', label: 'Monochrome', summary: 'Black and white with grain and a fade, like pushed Tri-X.',
    values: { contrast: 0.2, fade: 0.15, saturation: -1, grain: 0.55, grainSize: 0.45, vignette: 0.3 } },
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
  const look = { version: FILM_LOOK_VERSION, preset: FILM_LOOK_PRESET_IDS.includes(input.preset) ? input.preset : 'custom' };
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
  emit(`<feComposite in="SourceGraphic" in2="bg" operator="over" result=""/>`);

  const weave = v('weave');
  if (weave > 0) {
    const dx = weave * 0.004 * w * (Math.sin(f * 0.37) + 0.6 * Math.sin(f * 1.13)) / 1.6;
    const dy = weave * 0.004 * h * (Math.cos(f * 0.29) + 0.6 * Math.sin(f * 0.91)) / 1.6;
    emit(`<feOffset in="${cur}" dx="${n(dx)}" dy="${n(dy)}" result=""/>`);
  }
  const defocus = v('defocus');
  if (defocus > 0) emit(`<feGaussianBlur in="${cur}" stdDeviation="${n(Math.pow(defocus, 1.5) * 0.014 * w)}" edgeMode="duplicate" result=""/>`);

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
    const spread = emit(`<feGaussianBlur in="${bright}" stdDeviation="${n((0.008 + 0.03 * halation) * w)}" edgeMode="duplicate" result=""/>`);
    const tinted = emit(`<feColorMatrix in="${spread}" type="matrix" values="${n(hr)} 0 0 0 0 0 ${n(hg)} 0 0 0 0 0 ${n(hb)} 0 0 0 0 0 1 0" result=""/>`);
    emit(`<feComposite in="${pic}" in2="${tinted}" operator="arithmetic" k1="0" k2="1" k3="${n(1.3 * halation)}" k4="0" result=""/>`);
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
    const e = Math.pow(2, exposure) * (1 + flicker * 0.12 * (hash(f) * 2 - 1));
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
    const glow = emit(`<feFlood flood-color="${hex('leakColor', '#ff7a2a')}" x="${n(w * drift)}" y="${n(-h * 0.2)}" width="${n(w * 0.3)}" height="${n(h * 1.4)}" result=""/>`);
    const soft = emit(`<feGaussianBlur in="${glow}" stdDeviation="${n(0.09 * w)}" x="0" y="0" width="${n(w)}" height="${n(h)}" result=""/>`);
    const faded = emit(`<feComponentTransfer in="${soft}" result=""><feFuncA type="linear" slope="${n(leak * breathe)}" intercept="0"/></feComponentTransfer>`);
    emit(`<feBlend in="${faded}" in2="${pic}" mode="screen" result=""/>`);
  }

  const filter = `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB" primitiveUnits="userSpaceOnUse">${parts.join('')}</filter>`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>${filter}</defs></svg>`,
    filter,
    css: `url(#${id})`,
    active: parts.length > 2,
  };
}

/**
 * A browser script that applies a look to the page it runs in, re-seeding it
 * for every song frame: installed in the composition live preview and in the
 * final render's browser (`Page.addScriptToEvaluateOnNewDocument`) before the
 * document's own scripts. It exposes `window.__portosFilmLook`:
 *
 *   apply(look)   put a (normalized) look on the page, or null to clear it
 *   frame(n)      redraw the filter for song frame n (grain, weave, flicker, leak)
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
  const ID = 'portos-film-look';
  let look = ${JSON.stringify(normalizeFilmLook(look))};
  let frame = 0;
  let fps = 24;
  let host = null;
  const draw = () => {
    const root = document.documentElement;
    if (!root) return;
    const built = look ? markup(look, { frame, width: root.clientWidth || innerWidth || 1920, height: root.clientHeight || innerHeight || 1080, id: ID }) : null;
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
    frame(n) { const next = Math.max(0, Math.floor(Number(n) || 0)); if (next !== frame || !host) { frame = next; if (look) draw(); } },
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
