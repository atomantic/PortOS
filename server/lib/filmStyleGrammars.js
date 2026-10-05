/**
 * Film style grammar catalog (#10252, phase 1 of #10251).
 *
 * A grammar is a curated description of a code-rendered medium — how it is
 * imitated procedurally, its colour and type logic, how it moves, the camera
 * vocabulary it speaks, what it sounds like, and the moves only it can make —
 * written for an authoring prompt to consume. Original wording and an original
 * initial set; no entry names a real film, brand, or licensed typeface (fonts
 * are described by role and must be local).
 *
 * Pure leaf: data + renderer, no I/O. The record contract lives in
 * `filmStyleGrammarValidation.js`.
 */
import { ServerError } from './errorHandler.js';
import { trimTo } from './textUtils.js';
import { FILM_STYLE_PARTS, filmStylePartsSchema } from './filmStyleGrammarValidation.js';

/** Upper bound for one rendered grammar prompt section, in characters. */
export const FILM_STYLE_PROMPT_MAX_CHARS = 2500;

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export const FILM_STYLE_GRAMMARS = deepFreeze([
  {
    id: 'risograph-two-ink',
    label: 'Risograph two-ink print',
    category: 'print',
    summary: 'Two spot inks on warm paper, visible grain and slight misregistration between plates.',
    essence: {
      traits: [
        'Exactly two flat spot inks plus the paper colour; overlaps make a third, darker mix',
        'Halftone or stochastic grain inside every fill, never a smooth gradient',
        'Plates drift a few pixels out of register, so edges show a sliver of the other ink',
              ],
      confusedWith: ['Flat vector illustration (no grain, perfect registration)', 'Screen print poster (heavier, opaque ink)'],
    },
    rendering: 'Draw each ink as its own layer, rasterise it through a grain or dot mask, and multiply it over a paper texture. Offset one plate by a small fixed vector per scene. Grain and paper are anchored to the sheet, so shapes slide under a stable texture.',
    colourLogic: 'Two contrasting inks (say warm pink and deep teal). Every tone is a coverage percentage of one ink; overprint is the only dark. No pure black unless it is an ink.',
    type: 'A heavy grotesque display face for titles, printed in one ink with the same grain; captions in a plain monospace at small size. Type sits on the paper layer and misregisters with its plate.',
    motion: 'Step animation on twos or threes, like flipping printed sheets. Shapes move with simple ease-out. Grain re-rolls each held frame for a boiling texture. The paper and the plate offset never animate within a scene.',
    camera: [
      { move: 'Slow lateral slide', expresses: 'Reading along a printed strip', canServe: ['timelines', 'process steps'] },
      { move: 'Hard cut to a new sheet', expresses: 'Turning the page of a zine', canServe: ['chapter breaks', 'lists'] },
      { move: 'Push-in on a halftone', expresses: 'Looking closer until the dots show', canServe: ['detail reveals', 'emphasis'] },
    ],
    sound: 'Dry lo-fi palette: drum machine, plucked bass, the rhythmic thump and whirr of a print drum as foley on cuts. Leave silence under the title card.',
    nativeMoves: [
      { name: 'Register snap', how: 'Plates start far apart and slide into alignment, the overprint colour appearing as they meet.', fitsContentLike: ['product reveals', 'logos', 'two ideas merging'] },
      { name: 'Ink-only reveal', how: 'Show one plate alone, half-legible, then lay the second ink down to complete it.', fitsContentLike: ['before/after', 'answers to a question'] },
      { name: 'Grain dissolve', how: 'Raise the dot threshold until a shape crumbles into scattered grain, then gather it into the next shape.', fitsContentLike: ['transitions', 'transformation'] },
    ],
    pitfalls: 'Do not add a third ink, drop shadows, or smooth gradients. Avoid perfect registration; it reads as vector art. Keep grain scale consistent between scenes.',
  },
  {
    id: 'blueprint-draft',
    label: 'Blueprint draft',
    category: 'drawing',
    summary: 'White construction lines drawn onto a deep blue sheet with grid, dimensions and annotations.',
    essence: {
      traits: [
        'Thin even-weight white or pale cyan lines on a saturated blue ground',
        'A faint grid and a title block anchor the sheet',
        'Construction lines, dimension arrows and leader notes are part of the picture',
        'Objects are shown in orthographic or exploded views, not in perspective drama',
      ],
      confusedWith: ['Generic dark-mode UI wireframe', 'Chalkboard sketch (rougher, hand-made)'],
    },
    rendering: 'Draw geometry as SVG or canvas paths revealed by animating stroke dash offset. Grid and title block live on the sheet layer; parts and labels live on a drafting layer above it. Add a soft paper-fold texture and slight line bloom at low opacity.',
    colourLogic: 'One deep blue ground, one line colour, and at most one highlight (amber or red) reserved for the element under discussion. Fills are hatching, never solid.',
    type: 'A technical sans or monospace in capitals for labels and dimensions; the title block uses the same family at a larger size. Text is written on with the lines.',
    motion: 'Lines draw on at constant speed, as if inked with a ruler. Parts explode apart along their axes with linear or gentle ease-in-out. The grid and title block never move.',
    camera: [
      { move: 'Orthographic pan across the sheet', expresses: 'Surveying a full plan', canServe: ['architecture', 'system overviews'] },
      { move: 'Zoom to a detail callout', expresses: 'Inspecting a tolerance', canServe: ['key features', 'specs'] },
      { move: 'Static frame while lines draw', expresses: 'Design emerging from intent', canServe: ['origin stories', 'how it works'] },
    ],
    sound: 'Pencil and pen scratches, ruler taps, a soft ambient drone. Mechanical clicks when parts lock together; silence while a dimension is read.',
    nativeMoves: [
      { name: 'Exploded assembly', how: 'Pull an object apart along its axes, label each part, then reassemble it.', fitsContentLike: ['product anatomy', 'architecture', 'teardowns'] },
      { name: 'Dimension lock', how: 'Draw a dimension arrow whose value counts up to the final number.', fitsContentLike: ['metrics', 'performance claims'] },
      { name: 'Revision cloud', how: 'Circle a region with a scalloped cloud and stamp a revision note beside it.', fitsContentLike: ['changelogs', 'fixes', 'what is new'] },
    ],
    pitfalls: 'Avoid perspective camera moves and glossy lighting. Do not fill shapes solidly. Keep line weight consistent; varied brush strokes break the drafting feel.',
  },
  {
    id: 'silent-film-print',
    label: 'Silent-film print',
    category: 'film',
    summary: 'Monochrome projected film with flicker, scratches, iris transitions and ornate intertitles.',
    essence: {
      traits: [
        'Warm-toned monochrome image with crushed blacks and blooming highlights',
        'Projector flicker, gate weave, dust and vertical scratches',
        'Story carried by intertitle cards rather than spoken audio',
        'Iris and vignette transitions frame the action',
      ],
      confusedWith: ['Plain black-and-white video filter', 'Sepia photo slideshow (no motion artefacts)'],
    },
    rendering: 'Render the scene, desaturate it and apply a warm tone curve. Add a screen-space film layer: per-frame brightness flicker, subpixel gate jitter, dust specks and scratches that live for a few frames. Vignette and iris are a mask over everything.',
    colourLogic: 'Single hue: tinted greys from near-black to warm cream. A whole scene may take a monochrome tint (amber for day, blue for night) as early film did.',
    type: 'Intertitles use a decorative serif display face for dialogue and a plainer serif for narration, centred inside a thin ornamental border on black.',
    motion: 'Slightly undercranked feel: action plays a touch fast with a lower frame rate (around 16 to 18 fps). Mostly linear motion. The film grain and scratches never stop, even on held cards.',
    camera: [
      { move: 'Locked-off wide shot', expresses: 'The stage as a whole', canServe: ['introductions', 'ensembles'] },
      { move: 'Iris in on a subject', expresses: 'Attention narrowing to one thing', canServe: ['focus', 'endings'] },
      { move: 'Cut to intertitle', expresses: 'The narrator speaking', canServe: ['quotes', 'key messages'] },
    ],
    sound: 'Solo piano or small band score that follows the mood, projector whirr underneath. Foley is sparse and comic. Silence and projector noise alone for intertitles.',
    nativeMoves: [
      { name: 'Iris reveal', how: 'Open from a small circle on a detail to the full frame, or close down to end a beat.', fitsContentLike: ['reveals', 'chapter endings'] },
      { name: 'Intertitle punchline', how: 'Cut from action to a card that delivers the line, then back to a reaction.', fitsContentLike: ['quotes', 'jokes', 'testimonials'] },
      { name: 'Film burn', how: 'Let a hot spot bloom and eat the frame from the centre to transition scenes.', fitsContentLike: ['dramatic shifts', 'failures'] },
    ],
    pitfalls: 'No colour UI, modern fonts or smooth 60 fps motion. Keep artefacts subtle enough to read the frame. Do not loop one scratch pattern visibly.',
  },
  {
    id: 'pixel-16-bit',
    label: '16-bit pixel scene',
    category: 'digital',
    summary: 'Low-resolution sprites and tiles on a limited palette, scaled up with hard nearest-neighbour pixels.',
    essence: {
      traits: [
        'Native canvas around 320x180 scaled up with nearest-neighbour filtering',
        'Limited palette per sprite and dithering instead of gradients',
        'Tile-based backgrounds with parallax layers',
        'Sprites animate in a handful of hand-placed frames',
      ],
      confusedWith: ['Voxel 3D (has depth)', 'Low-resolution photo filter (not hand-placed)'],
    },
    rendering: 'Draw at the native resolution into an offscreen canvas, snap every position to whole pixels, then scale up without smoothing. Backgrounds are tilemaps in two or three parallax layers; HUD and dialog boxes are screen-space and never scroll.',
    colourLogic: 'A fixed palette of about 32 colours for the whole film; each sprite uses at most 16. Shade with palette steps and ordered dithering. Night and danger are palette swaps, not filters.',
    type: 'A bitmap pixel font at native resolution for dialog and HUD; titles may use a larger chunky pixel face with a one-pixel outline. Dialog types out letter by letter.',
    motion: 'Sprite cycles of 2 to 6 frames, positions moving in whole-pixel steps. Easing is coarse and quantised. The HUD frame and the palette never move.',
    camera: [
      { move: 'Side-scroll follow', expresses: 'A journey from left to right', canServe: ['roadmaps', 'progress'] },
      { move: 'Screen-by-screen flip', expresses: 'Entering a new room', canServe: ['sections', 'feature tours'] },
      { move: 'Screen shake', expresses: 'Impact', canServe: ['big numbers', 'launch moments'] },
    ],
    sound: 'Chiptune with square, triangle and noise channels; short bleeps for UI and pickups. Silence right before a boss-style reveal.',
    nativeMoves: [
      { name: 'Item get', how: 'A character holds an item overhead while a jingle plays and a dialog box names it.', fitsContentLike: ['new features', 'achievements'] },
      { name: 'Level map', how: 'Zoom out to a world map with a path of nodes, lighting the next node.', fitsContentLike: ['roadmaps', 'onboarding steps'] },
      { name: 'Palette flash', how: 'Swap the entire palette for a frame or two on impact or success.', fitsContentLike: ['emphasis', 'alerts'] },
    ],
    pitfalls: 'No sub-pixel motion, rotation blur or anti-aliasing. Do not mix pixel scales. Keep palette discipline; a smooth gradient breaks the illusion.',
  },
  {
    id: 'paper-cut-lightbox',
    label: 'Paper-cut lightbox',
    category: 'craft',
    summary: 'Layered cut-paper silhouettes backlit in a shallow box, with soft shadows and glowing gaps.',
    essence: {
      traits: [
        'Several flat paper layers stacked at shallow depths',
        'Light behind the stack glows through gaps and edges',
        'Soft drop shadows between layers reveal depth',
        'Silhouettes have slightly irregular hand-cut edges and paper fibre',
      ],
      confusedWith: ['Flat vector parallax (no light or shadow)', 'Stop-motion cutout animation (frontlit)'],
    },
    rendering: 'Build 4 to 7 layers of shapes, each with a paper texture and a blurred shadow cast onto the layer behind. Place a radial light gradient at the back. Layers are world-anchored in a shallow box; a subtle frame vignette is screen-space.',
    colourLogic: 'Each layer is one colour, stepping from darkest in front to lightest near the light. Use one warm or cool family per scene and let the backlight supply the glow.',
    type: 'Titles cut from paper in a rounded humanist or slab display face, set into a layer with the same shadow. Body captions in a quiet sans, printed on a front label strip.',
    motion: 'Layers slide on rails at different speeds; pieces hinge and pop up like a theatre set. Motion uses soft ease-in-out with a little overshoot. The box frame and light source position do not move.',
    camera: [
      { move: 'Parallax dolly', expresses: 'Leaning to look into the box', canServe: ['scene setting', 'worlds'] },
      { move: 'Rack focus between layers', expresses: 'Shifting attention front to back', canServe: ['comparisons', 'layers of a system'] },
      { move: 'Light dim and brighten', expresses: 'Time passing', canServe: ['day/night', 'before/after'] },
    ],
    sound: 'Music box, felt piano, paper rustles and soft slides; a small pop when a piece stands up. Quiet room tone between beats.',
    nativeMoves: [
      { name: 'Pop-up raise', how: 'A flat piece hinges up from the floor layer to stand in the scene.', fitsContentLike: ['introductions', 'new items'] },
      { name: 'Light-through reveal', how: 'Brighten the backlight so hidden cut-outs in a layer appear as glowing shapes.', fitsContentLike: ['hidden insights', 'secrets'] },
      { name: 'Layer peel', how: 'Slide the front layer away to expose the scene behind it.', fitsContentLike: ['deeper detail', 'transitions'] },
    ],
    pitfalls: 'Avoid hard shadows or gradients painted inside a layer. Do not move the light randomly. Too many layers flatten the depth; keep it shallow.',
  },
  {
    id: 'isometric-low-poly',
    label: 'Isometric low-poly world',
    category: 'dimensional',
    summary: 'Faceted low-poly objects in a fixed isometric view on small floating terrain islands.',
    essence: {
      traits: [
        'Fixed isometric or near-isometric orthographic angle',
        'Flat-shaded faceted geometry with a low triangle count',
        'Small diorama islands or tiles floating in clean space',
        'Soft ambient lighting with one clear sun direction',
      ],
      confusedWith: ['Realistic 3D render', 'Flat isometric vector illustration (no lighting)'],
    },
    rendering: 'Render with an orthographic camera at a fixed angle, flat-shaded materials and one directional light plus ambient. Islands are world-anchored; labels and callouts are screen-space overlays pinned to world points.',
    colourLogic: 'Pastel or muted palette with a gentle colour per material; shading comes from the light, not texture. A single accent marks the focus object.',
    type: 'A geometric sans for titles and labels, placed on flat tags floating above objects with a thin leader line.',
    motion: 'Objects build up in stacks with spring easing, tiles rise from below, small units travel along paths. The camera angle and light direction stay fixed.',
    camera: [
      { move: 'Orthographic pan across islands', expresses: 'Touring a system', canServe: ['architecture', 'ecosystems'] },
      { move: 'Zoom in on one tile', expresses: 'Focusing on a component', canServe: ['feature detail', 'case studies'] },
      { move: 'Slow orbit snap to a new angle', expresses: 'Seeing the other side', canServe: ['comparisons', 'perspectives'] },
    ],
    sound: 'Light marimba and synth pads, soft clicks and blips as tiles snap into place. Ambient wind beneath, silence on the final wide view.',
    nativeMoves: [
      { name: 'Tile rise', how: 'Raise new tiles from below the grid with a spring, building the world piece by piece.', fitsContentLike: ['growth', 'onboarding', 'building products'] },
      { name: 'Path flow', how: 'Send small units along a path between islands to show data or goods moving.', fitsContentLike: ['pipelines', 'integrations'] },
      { name: 'Island split', how: 'Crack an island into two and drift them apart to compare options.', fitsContentLike: ['comparisons', 'migrations'] },
    ],
    pitfalls: 'Avoid perspective distortion, high-poly detail and realistic textures. Do not tilt the camera arbitrarily. Keep labels readable above the scene.',
  },
  {
    id: 'keynote-type-and-ui',
    label: 'Keynote type-and-UI',
    category: 'interface',
    summary: 'Large confident type and clean UI fragments on a plain stage, like a product keynote.',
    essence: {
      traits: [
        'Very large headline type with generous space and one idea per beat',
        'Real or mocked interface fragments presented as hero objects',
        'Plain dark or light stage with subtle depth and soft shadow',
        'Measured pacing with precise, smooth motion',
      ],
      confusedWith: ['Slide deck screenshots (static)', 'UI screen recording (no staging)'],
    },
    rendering: 'Compose type and UI cards as DOM or canvas layers on a plain stage with soft shadows and a faint gradient. UI fragments are world objects that can scale and tilt; captions and progress dots are screen-space.',
    colourLogic: 'Neutral stage with high-contrast text; colour comes from the product UI itself and one accent for emphasis words.',
    type: 'One neo-grotesque family from the local system fonts in heavy and regular weights; headlines are short, tightly tracked and kinetic.',
    motion: 'Smooth 60 fps with expressive ease-out curves. Words slide, scale and mask in; UI cards float in depth. The stage and the type baseline grid never move.',
    camera: [
      { move: 'Slow push toward a UI card', expresses: 'Presenting a feature', canServe: ['feature launches', 'demos'] },
      { move: 'Lateral track past cards', expresses: 'A lineup of options', canServe: ['plans', 'product lines'] },
      { move: 'Hard cut on the beat', expresses: 'Confidence and rhythm', canServe: ['taglines', 'stats'] },
    ],
    sound: 'Clean electronic bed with a steady pulse, subtle whooshes and UI ticks. Pull the music out entirely under the key headline.',
    nativeMoves: [
      { name: 'Word swap', how: 'Hold a sentence and replace one word repeatedly to show range.', fitsContentLike: ['capabilities', 'audiences'] },
      { name: 'Hero card lift', how: 'Lift a UI card off the screen into depth, rotate gently, then settle it.', fitsContentLike: ['feature highlights', 'products'] },
      { name: 'Stat count-up', how: 'Count a large number up to its value with the unit appearing at the end.', fitsContentLike: ['metrics', 'milestones'] },
    ],
    pitfalls: 'Do not crowd the stage or show more than one idea at a time. Avoid novelty fonts and bouncy easing. Keep UI text legible at the final scale.',
  },
  {
    id: 'single-line-drawing',
    label: 'Single-line drawing',
    category: 'drawing',
    summary: 'One continuous unbroken line draws every figure and morphs from subject to subject.',
    essence: {
      traits: [
        'A single stroke of constant weight never lifts from the page',
        'Figures are minimal contours with no fills or shading',
        'The line morphs from one subject into the next',
        'Generous empty space around the drawing',
      ],
      confusedWith: ['Hand-drawn whiteboard explainer (many strokes)', 'Vector icon animation (closed shapes)'],
    },
    rendering: 'Represent the line as one long path, revealed with stroke dash offset; morph between subjects by interpolating resampled points of equal count. The page texture is screen-space; the line is world-anchored.',
    colourLogic: 'One ink colour on an off-white or dark page. A single accent colour may flood a closed region briefly for emphasis.',
    type: 'Captions are hand-lettered in the same line style, or set in a light humanist sans placed away from the drawing.',
    motion: 'The pen tip travels at a calm steady pace with slight ease at turns. Morphs use ease-in-out. The page never moves and the line never breaks.',
    camera: [
      { move: 'Follow the pen tip', expresses: 'A thought unfolding', canServe: ['stories', 'explanations'] },
      { move: 'Pull out to the whole drawing', expresses: 'Seeing the big picture', canServe: ['summaries', 'endings'] },
      { move: 'Hold still during a morph', expresses: 'One idea becoming another', canServe: ['transformations', 'cause and effect'] },
    ],
    sound: 'Sparse acoustic guitar or piano, a soft pen-on-paper sound tracking the line. Let silence hold when the drawing completes.',
    nativeMoves: [
      { name: 'Contour morph', how: 'Redraw one subject into another without lifting the line.', fitsContentLike: ['transformations', 'evolution'] },
      { name: 'Loose end pull', how: 'Pull the line tail out of a finished figure to begin the next scene.', fitsContentLike: ['transitions', 'continuity'] },
      { name: 'Flood fill accent', how: 'Briefly fill an enclosed shape with the accent colour, then drain it.', fitsContentLike: ['emphasis', 'key takeaways'] },
    ],
    pitfalls: 'Never break or duplicate the line. Avoid shading, fills that stay, and busy backgrounds. Keep morphs short enough to stay readable.',
  },
]);

const GRAMMARS_BY_ID = new Map(FILM_STYLE_GRAMMARS.map(grammar => [grammar.id, grammar]));

/** The grammar with this id, or null. */
export const getFilmStyleGrammar = (id) => GRAMMARS_BY_ID.get(id) ?? null;

/** Picker projection: enough to choose a grammar without its full text. */
export const summarizeFilmStyleGrammar = ({ id, label, category, summary, nativeMoves }) => ({
  id, label, category, summary, nativeMoves: nativeMoves.map(({ name }) => ({ name })),
});

const SECTION_RENDERERS = {
  essence: ({ essence }) => `Essence:\n${essence.traits.map(t => `- ${t}`).join('\n')}\nEasily confused with: ${essence.confusedWith.join('; ')}`,
  rendering: ({ rendering }) => `Rendering: ${rendering}`,
  colourLogic: ({ colourLogic }) => `Colour: ${colourLogic}`,
  type: ({ type }) => `Type: ${type}`,
  motion: ({ motion }) => `Motion: ${motion}`,
  camera: ({ camera }) => `Camera vocabulary:\n${camera.map(c => `- ${c.move}: ${c.expresses} (serves ${c.canServe.join(', ')})`).join('\n')}`,
  sound: ({ sound }) => `Sound: ${sound}`,
  nativeMoves: ({ nativeMoves }) => `Native moves:\n${nativeMoves.map(m => `- ${m.name}: ${m.how} (fits ${m.fitsContentLike.join(', ')})`).join('\n')}`,
  pitfalls: ({ pitfalls }) => `Pitfalls: ${pitfalls}`,
};

/**
 * Render one grammar as a bounded prompt section. `parts` is `'all'` (default)
 * or a subset of FILM_STYLE_PARTS; sections always render in catalog order.
 * Throws a 400 ServerError for an unknown id or invalid parts.
 */
export function renderFilmStyleGrammarPrompt(id, { parts = 'all' } = {}) {
  const grammar = getFilmStyleGrammar(id);
  if (!grammar) {
    throw new ServerError(`Unknown film style grammar: ${String(id).slice(0, 60)}`, { status: 400, code: 'FILM_STYLE_UNKNOWN' });
  }
  const parsed = filmStylePartsSchema.safeParse(parts);
  if (!parsed.success) {
    throw new ServerError(`Invalid film style parts; use 'all' or a subset of: ${FILM_STYLE_PARTS.join(', ')}`, { status: 400, code: 'FILM_STYLE_PARTS_INVALID' });
  }
  const selected = parsed.data === 'all' ? FILM_STYLE_PARTS : FILM_STYLE_PARTS.filter(part => parsed.data.includes(part));
  const body = [
    `## Film style grammar: ${grammar.label} (${grammar.category})`,
    grammar.summary,
    ...selected.map(part => SECTION_RENDERERS[part](grammar)),
  ].join('\n\n');
  return trimTo(body, FILM_STYLE_PROMPT_MAX_CHARS);
}
