/**
 * Storyboard panel recipes — the node graph the panel maker runs (Make tab).
 *
 * A recipe is a small graph: input nodes (the panel's own words, a style,
 * reference images) feed an image node, whose frames land on the panel as
 * takes. The default sends the shot as written with the style after it; an
 * LLM node (prompt enhancer) is optional, wired in between. The recipe is
 * the board's template (`board.recipe`, null = the default below); what a run
 * produced for one panel — the written prompt, the frames, the exact text sent
 * — lives on that panel as `panel.make.nodes[nodeId]`.
 *
 * Every node's value is visible in its card, so nothing reaches a model the
 * user cannot read (#11317): the text node shows the panel words it carries,
 * the system prompt is its own editable node, and a run records the exact
 * prompt it sent with each block PortOS added listed separately.
 *
 * Browser-safe: the client resolves the same values to draw the chain.
 */

import { newStoryboardEntityId } from './storyboardVocabulary.js';

export const RECIPE_NODE_TYPES = Object.freeze(['text', 'system', 'llm', 'references', 'image', 'panel']);
export const RECIPE_TEXT_SOURCES = Object.freeze(['panel', 'beat', 'custom']);
export const RECIPE_NODE_STATUSES = Object.freeze(['idle', 'running', 'queued', 'done', 'failed']);

// Port kinds: an input accepts one edge from an output of the same kind.
export const RECIPE_NODE_PORTS = Object.freeze({
  text: { inputs: {}, output: 'text' },
  system: { inputs: {}, output: 'text' },
  llm: { inputs: { prompt: 'text', system: 'text' }, output: 'text' },
  references: { inputs: {}, output: 'images' },
  image: { inputs: { prompt: 'text', style: 'text', images: 'images' }, output: 'frames' },
  panel: { inputs: { frames: 'frames' }, output: null },
});

export const RECIPE_PORT_LABELS = Object.freeze({ prompt: 'Prompt', system: 'System prompt', style: 'Style', images: 'References', frames: 'Frames' });

export const RECIPE_TYPE_TITLES = Object.freeze({
  text: 'Text', system: 'System prompt', llm: 'Prompt writer', references: 'References', image: 'Image', panel: 'Panel',
});

export const RECIPE_LIMITS = Object.freeze({
  nodes: 24,
  title: 80,
  text: 8000,
  images: 12,
  frames: 4,
  sentPrompt: 24000,
  additions: 12,
  error: 500,
  // The image job route refuses a longer prompt; the Run is refused with the
  // count rather than cutting the model's words.
  imagePrompt: 4000,
});

// Render size per board aspect, on 64 px multiples the local and cloud
// backends all accept.
export const STORYBOARD_RENDER_SIZES = Object.freeze({
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 896, height: 1152 },
  '2.39:1': { width: 1536, height: 640 },
});

const ART_STYLE_WORDS = Object.freeze({
  pencil: 'a rough pencil storyboard sketch: loose graphite lines, light blue perspective guides, white paper',
  'clean-line': 'clean black ink storyboard line art, no shading, white background',
  'grey-marker': 'a grey marker storyboard frame: quick tonal shading, bold ink outlines',
  color: 'a full color storyboard concept frame, painterly, cinematic light',
});

// A production sketch is the board a director and cinematographer plan
// shots on: one consistent marker style, with red and blue marks as notes.
const PRODUCTION_SKETCH_PROMPT = [
  'You write one prompt for an image model that draws a rough production storyboard sketch of one shot.',
  'From the shot description you are given, keep its subject, action and intent; add no characters, places or props it does not imply, and describe people by role, pose and clothing shape, never by name.',
  'Use exactly the framing and camera the description names (an over-the-shoulder stays over the shoulder, a close stays close); only when it names none, pick one clear shot size and camera angle that tells the moment. Say what sits in the foreground, middle and back, where the subject is in the frame and which way they face or move.',
  'Then ask for this style every time: a fast, loose sketch on a plain white page in soft gray marker or brush pen, quick uneven overlapping strokes and simple boxy shapes;',
  'simple greybox placeholder figures with blank faces and no likeness, the action and feeling carried by pose and body language; a sparse background with only enough lines to place the scene; light gray hatching at most, no solid blacks, color fills or photo realism;',
  'bold red arrows and speed lines showing which way people, objects and the camera move (more for fast action, none when nothing moves), drawn as annotation marks, never as objects or light;',
  'a loose blue horizon line and a few blue lines to the vanishing point, left visible like a drawing guide; everything else gray.',
  'The picture has no text, letters, numbers, labels, logos, borders or panels: one drawing filling the frame.',
  'Write one paragraph of 70 to 120 words, scene and framing first, then the style. Answer with the prompt only.',
].join(' ');

// The style the image model reads after the shot, in its own words: no LLM
// rewrites the shot first. A classic greybox board: placeholders that show
// camera, action, emotion and direction, never likeness or detail.
const PRODUCTION_SKETCH_STYLE = [
  'Classic rough storyboard frame on a plain white page: fast, loose gray pencil lines and quick tonal shading, unfinished like a working sketch.',
  'People are simple greybox placeholder figures with blank faces and no likeness, hair or costume detail: pose, gesture and body language carry the action and the emotion.',
  'Treat any reference images only as notes on who is where and how the place is laid out, never as a likeness to copy.',
  'Props and the set are plain blocked-in shapes, with only enough background to place the scene.',
  'The camera is clear: the shot size and angle read at a glance, with thin blue perspective lines running to the vanishing point.',
  'Bold red arrows and speed lines show which way people, objects and the camera move.',
  'No color fills or photo realism; no text, letters, numbers, labels, logos, borders or panels: one drawing filling the frame.',
].join(' ');

// Earlier shipped defaults of the style above. A saved recipe whose style
// node still holds one of these is an untouched default, so it reads as the
// current one; text the user edited is theirs and stays.
export const RETIRED_STORYBOARD_STYLES = Object.freeze({
  'production-sketch': [[
    'Rough production storyboard sketch on a plain white page: fast, loose soft gray marker strokes and simple boxy shapes;',
    'gesture figures with blank oval heads and no facial features; a sparse background with only enough lines to place the scene;',
    'light gray hatching at most, no solid blacks, color fills or photo realism;',
    'loose red pencil streaks showing the direction of movement; a loose blue horizon line and a few blue perspective guide lines.',
    'No text, letters, numbers, labels, arrows, logos, borders or panels: one drawing filling the frame.',
  ].join(' ')],
});

/** The default style text for a board's art style (its own node, sent after the shot as written). */
export function defaultStoryboardStyle(artStyle) {
  if (artStyle === 'production-sketch') return PRODUCTION_SKETCH_STYLE;
  return `Storyboard frame, ${ART_STYLE_WORDS[artStyle] || ART_STYLE_WORDS.pencil}. No text, labels or borders: one drawing filling the frame.`;
}

/**
 * The system prompt a prompt enhancer gets for a board's art style. Recipes
 * saved before the style node existed still carry it, so a style change can
 * recognize and swap it.
 */
export function defaultStoryboardSystemPrompt(artStyle) {
  if (artStyle === 'production-sketch') return PRODUCTION_SKETCH_PROMPT;
  const style = ART_STYLE_WORDS[artStyle] || ART_STYLE_WORDS.pencil;
  return [
    'You write one prompt for an image model.',
    `The image is ${style}.`,
    'From the shot description you are given, describe what is in frame: who, where, the action, the framing and camera angle.',
    'Keep it under 80 words. Answer with the prompt only.',
  ].join(' ');
}

/**
 * Shot description → Image, with the Storyboard style and References wired in
 * → Panel. No LLM: the image model reads the shot as written, then the style.
 */
function defaultPanelRecipe(board = {}) {
  return {
    nodes: [
      { id: 'node-text', type: 'text', title: 'Shot description', x: 40, y: 40, text: '', settings: { source: 'panel' } },
      { id: 'node-system', type: 'system', title: 'Storyboard style', x: 40, y: 260, text: defaultStoryboardStyle(board.artStyle), settings: {} },
      { id: 'node-refs', type: 'references', title: 'References', x: 40, y: 480, text: '', settings: { linked: true }, images: [] },
      { id: 'node-image', type: 'image', title: 'Image', x: 400, y: 200, text: '', settings: { imageMode: null, imageModelId: null, count: 1 } },
      { id: 'node-panel', type: 'panel', title: 'Panel', x: 720, y: 200, text: '', settings: {} },
    ],
    edges: [
      { from: 'node-text', to: 'node-image', toPort: 'prompt' },
      { from: 'node-system', to: 'node-image', toPort: 'style' },
      { from: 'node-refs', to: 'node-image', toPort: 'images' },
      { from: 'node-image', to: 'node-panel', toPort: 'frames' },
    ],
  };
}

const NODE_ID_PATTERN = /^node-[A-Za-z0-9-]{1,80}$/;
const TYPE_SET = new Set(RECIPE_NODE_TYPES);
const SOURCE_SET = new Set(RECIPE_TEXT_SOURCES);
const STATUS_SET = new Set(RECIPE_NODE_STATUSES);
const IMAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const optStr = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '');
const coord = (value) => (Number.isFinite(value) ? Math.round(Math.max(-10000, Math.min(value, 10000))) : 0);

function imageList(value, max = RECIPE_LIMITS.images) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const image = typeof item?.image === 'string' && IMAGE_NAME_PATTERN.test(item.image) ? item.image : null;
    if (!image || seen.has(image)) continue;
    seen.add(image);
    out.push({ image, label: optStr(item.label, RECIPE_LIMITS.title) });
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeSettings(type, raw = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  if (type === 'text') return { source: SOURCE_SET.has(s.source) ? s.source : 'panel' };
  if (type === 'llm') return { providerId: optStr(s.providerId, 128), model: optStr(s.model, 256), effort: optStr(s.effort, 64) };
  if (type === 'references') return { linked: s.linked !== false };
  if (type === 'image') {
    const count = Number.isInteger(s.count) ? Math.max(1, Math.min(s.count, RECIPE_LIMITS.frames)) : 1;
    return { imageMode: optStr(s.imageMode, 64) || null, imageModelId: optStr(s.imageModelId, 256) || null, count };
  }
  return {};
}

function sanitizeNode(raw) {
  if (!raw || typeof raw !== 'object' || !TYPE_SET.has(raw.type)) return null;
  const id = typeof raw.id === 'string' && NODE_ID_PATTERN.test(raw.id) ? raw.id : newStoryboardEntityId('node');
  return {
    id,
    type: raw.type,
    title: optStr(raw.title, RECIPE_LIMITS.title) || RECIPE_TYPE_TITLES[raw.type],
    x: coord(raw.x),
    y: coord(raw.y),
    text: raw.type === 'text' || raw.type === 'system' ? str(raw.text, RECIPE_LIMITS.text) : '',
    settings: sanitizeSettings(raw.type, raw.settings),
    ...(raw.type === 'references' ? { images: imageList(raw.images) } : {}),
  };
}

/**
 * Normalize a recipe, or null for "use the default". Edges must join an
 * existing output to a matching input; an input keeps its first edge, and an
 * edge that would close a cycle is dropped (runs walk the graph upstream).
 */
export function sanitizeRecipe(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
  const nodes = [];
  const byId = new Map();
  for (const item of raw.nodes) {
    if (nodes.length >= RECIPE_LIMITS.nodes) break;
    const node = sanitizeNode(item);
    if (!node || byId.has(node.id)) continue;
    byId.set(node.id, node);
    nodes.push(node);
  }
  const edges = [];
  const taken = new Set();
  for (const edge of Array.isArray(raw.edges) ? raw.edges : []) {
    const from = byId.get(edge?.from);
    const to = byId.get(edge?.to);
    if (!from || !to || from === to) continue;
    const kind = RECIPE_NODE_PORTS[to.type].inputs[edge.toPort];
    if (!kind || RECIPE_NODE_PORTS[from.type].output !== kind) continue;
    const slot = `${to.id}:${edge.toPort}`;
    if (taken.has(slot)) continue;
    const next = { from: from.id, to: to.id, toPort: edge.toPort };
    if (reaches([...edges, next], to.id, from.id)) continue;
    taken.add(slot);
    edges.push(next);
  }
  return { nodes, edges };
}

function reaches(edges, start, target) {
  const stack = [start];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of edges) if (edge.from === id) stack.push(edge.to);
  }
  return false;
}

/** The recipe a board runs: its own, else the default for its art style. */
/** Whether `text` is a shipped default style (current or earlier) for `artStyle`. */
export const isDefaultStoryboardStyle = (text, artStyle) =>
  text === defaultStoryboardStyle(artStyle) || (RETIRED_STORYBOARD_STYLES[artStyle] || []).includes(text);

export function effectiveRecipe(board) {
  const saved = sanitizeRecipe(board?.recipe);
  if (!saved) return defaultPanelRecipe(board);
  for (const node of saved.nodes) {
    if (node.type === 'system' && isDefaultStoryboardStyle(node.text, board.artStyle)) node.text = defaultStoryboardStyle(board.artStyle);
  }
  return saved;
}

/** The node wired into `nodeId`'s `port`, or null. */
export function upstreamNode(recipe, nodeId, port) {
  const edge = recipe.edges.find((e) => e.to === nodeId && e.toPort === port);
  return edge ? recipe.nodes.find((n) => n.id === edge.from) || null : null;
}

/** Nodes in run order: every node after the nodes that feed it. */
export function recipeRunOrder(recipe) {
  const order = [];
  const placed = new Set();
  const visit = (node, trail = new Set()) => {
    if (placed.has(node.id) || trail.has(node.id)) return;
    trail.add(node.id);
    for (const edge of recipe.edges) {
      if (edge.to !== node.id) continue;
      const from = recipe.nodes.find((n) => n.id === edge.from);
      if (from) visit(from, trail);
    }
    placed.add(node.id);
    order.push(node);
  };
  for (const node of recipe.nodes) visit(node);
  return order;
}

const FRAMING_WORDS = Object.freeze({
  'extreme-wide': 'extreme wide shot', wide: 'wide establishing shot', full: 'full shot, head to toe',
  'medium-wide': 'medium wide shot, knees up', medium: 'medium shot', 'medium-close': 'medium close-up, chest up', close: 'close-up',
  'extreme-close': 'extreme close-up', insert: 'insert shot of a detail', 'over-the-shoulder': 'over-the-shoulder shot', 'two-shot': 'two-shot', group: 'group shot, three or more people sharing the frame', pov: 'point-of-view shot',
});
const ANGLE_WORDS = Object.freeze({
  'eye-level': 'eye-level angle', high: 'high angle looking down', low: 'low angle looking up',
  'birds-eye': "bird's-eye view straight down", 'worms-eye': "worm's-eye view from the ground", 'ground-level': 'ground-level camera, the lens just above the floor', dutch: 'Dutch angle, tilted horizon',
});
// Image models drift to a 3/4 view, so each facing names the view and what
// the camera does and doesn't see.
const FACING_WORDS = Object.freeze({
  front: 'front view, the subject faces the camera head-on, body square to the lens, both shoulders and the whole face toward the viewer, not turned to the side',
  'three-quarter': 'three-quarter view, the subject turned about 45 degrees from the camera, one side of the face toward the viewer',
  profile: 'side profile, the subject turned 90 degrees from the camera, seen exactly side-on',
  'three-quarter-back': 'three-quarter rear view, the subject turned mostly away from the camera, the back of the head and one shoulder toward the viewer, face barely visible',
  back: 'rear view from directly behind, the subject faces away from the camera, only their back and the back of the head visible, no face',
});

const COMPOSITION_WORDS = Object.freeze({
  center: 'the subject centered in the frame, symmetrical composition',
  'left-third': 'the subject on the left third of the frame, open space on the right',
  'right-third': 'the subject on the right third of the frame, open space on the left',
  'cut-left': 'the subject at the left edge of the frame, partly cut off by the edge, the rest of the frame open',
  'cut-right': 'the subject at the right edge of the frame, partly cut off by the edge, the rest of the frame open',
  'low-in-frame': 'the subject low in the frame, a large empty space above them',
  'frame-within-frame': 'the subject seen through a doorway or window that frames them',
  'foreground-object': 'an object close to the camera in the foreground, out of focus, the subject behind it',
});

const LENS_WORDS = Object.freeze({
  'wide-angle': 'wide-angle lens, exaggerated depth', normal: 'normal 50mm lens, natural perspective', telephoto: 'telephoto lens, compressed background',
});
const FOCUS_WORDS = Object.freeze({
  'shallow-focus': 'shallow depth of field, the background blurred', 'deep-focus': 'deep focus, foreground and background both sharp',
});
const EYELINE_WORDS = Object.freeze({
  'into-lens': 'looking straight into the lens, eye contact with the viewer', 'off-left': 'looking off to the left of the frame, not at the camera',
  'off-right': 'looking off to the right of the frame, not at the camera', 'looking-down': 'eyes cast down', 'looking-up': 'looking up',
});

/**
 * The words a text node carries for one panel: the panel's own fields (each
 * on a labeled line), the beat's description, or the node's custom text.
 */
export function textNodeValue(node, { beat, panel } = {}) {
  const source = node?.settings?.source;
  if (source === 'custom') return node.text || '';
  if (source === 'beat') return [beat?.what, beat?.why].filter((v) => v && v.trim()).join('\n');
  // Words a picture can show: the dialogue or lyric stays off, since the
  // image would letter it. The camera move stays off too: a still can't show
  // it, and imported boards carry free text there ("a loose wide shot") that
  // fought the framing and angle the user picked.
  return [panel?.action, storyboardPanelShotText(panel)].filter((v) => v && v.trim()).join('\n');
}

/**
 * A panel's shot picks (framing, angle, facing, composition, lens, focus,
 * eyeline) as labeled lines; '' when none is picked. The camera move's free
 * text stays out (see textNodeValue).
 */
export function storyboardPanelShotText(panel) {
  return [
    panel?.framing ? `Framing: ${FRAMING_WORDS[panel.framing] || panel.framing}.` : '',
    panel?.angle ? `Angle: ${ANGLE_WORDS[panel.angle] || panel.angle}.` : '',
    panel?.facing ? `Subject: ${FACING_WORDS[panel.facing] || panel.facing}.` : '',
    panel?.composition ? `Composition: ${COMPOSITION_WORDS[panel.composition] || panel.composition}.` : '',
    panel?.lens || panel?.focus ? `Lens: ${[LENS_WORDS[panel.lens], FOCUS_WORDS[panel.focus]].filter(Boolean).join(', ')}.` : '',
    panel?.eyeline ? `Eyes: ${EYELINE_WORDS[panel.eyeline] || panel.eyeline}.` : '',
  ].filter((v) => v && v.trim()).join('\n');
}

/** A panel's per-node run state for `nodeId` (never null). */
export const panelNodeState = (panel, nodeId) => panel?.make?.nodes?.[nodeId] || EMPTY_NODE_STATE;

const EMPTY_NODE_STATE = Object.freeze({
  text: '', status: 'idle', error: '', sentPrompt: '', promptAdditions: [], providerId: '', model: '',
  runId: '', frameCount: 0, jobIds: [], failedJobIds: [], takeIds: [], excludedRefs: [], extraRefs: [], sentRefs: [], selectOnLand: false, runAt: null,
});

/**
 * The value flowing out of a node for one panel: text for text-kind outputs,
 * an image list for references, take ids for an image node.
 * `linkedRefs` are the panel's catalog images the server resolved.
 */
function nodeOutputValue(recipe, node, { beat, panel, linkedRefs = [] } = {}) {
  if (!node) return null;
  const state = panelNodeState(panel, node.id);
  if (node.type === 'text') return textNodeValue(node, { beat, panel });
  if (node.type === 'system') return node.text || '';
  if (node.type === 'llm') return state.text || '';
  if (node.type === 'references') {
    const excluded = new Set(state.excludedRefs);
    const linked = node.settings?.linked ? linkedRefs.filter((ref) => !excluded.has(ref.image)) : [];
    return imageList([...(node.images || []), ...linked, ...state.extraRefs], RECIPE_LIMITS.images);
  }
  if (node.type === 'image') return state.takeIds;
  return null;
}

/** The value arriving at `nodeId`'s `port` for one panel ('' / [] when unwired). */
export function nodeInputValue(recipe, nodeId, port, context) {
  const from = upstreamNode(recipe, nodeId, port);
  const value = nodeOutputValue(recipe, from, context);
  if (value !== null) return value;
  return RECIPE_NODE_PORTS[recipe.nodes.find((n) => n.id === nodeId)?.type]?.inputs[port] === 'text' ? '' : [];
}

/**
 * What an image node sends: the shot (its Prompt input) as written, then a
 * correction note, then the style (its Style input). Each block PortOS adds
 * is listed (`additions`), so the run and its preview show the same text.
 */
export function imageNodePrompt(recipe, nodeId, context, { note = '' } = {}) {
  const shot = nodeInputValue(recipe, nodeId, 'prompt', context).trim();
  const style = nodeInputValue(recipe, nodeId, 'style', context).trim();
  const styleNode = upstreamNode(recipe, nodeId, 'style');
  const correction = note.trim() ? `Redraw the first reference frame with this change: ${note.trim()}` : '';
  const additions = [
    correction ? { id: 'correction', label: 'Correction', text: correction } : null,
    style ? { id: 'style', label: `Style (${styleNode?.title || 'node'})`, text: style } : null,
  ].filter(Boolean);
  return { shot, prompt: shot ? [shot, correction, style].filter(Boolean).join('\n\n') : '', additions };
}

function sanitizeAdditions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a) => a && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.text === 'string')
    .slice(0, RECIPE_LIMITS.additions)
    .map((a) => ({ id: a.id.slice(0, 80), label: a.label.slice(0, 120), text: a.text.slice(0, RECIPE_LIMITS.text) }));
}

const idList = (value, max, pattern = /^[A-Za-z0-9:_-]{1,128}$/) => (Array.isArray(value)
  ? [...new Set(value.filter((v) => typeof v === 'string' && pattern.test(v)))].slice(0, max)
  : []);

function sanitizeNodeState(raw, takeIds) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    text: str(raw.text, RECIPE_LIMITS.text),
    status: STATUS_SET.has(raw.status) ? raw.status : 'idle',
    error: str(raw.error, RECIPE_LIMITS.error),
    sentPrompt: str(raw.sentPrompt, RECIPE_LIMITS.sentPrompt),
    promptAdditions: sanitizeAdditions(raw.promptAdditions),
    providerId: optStr(raw.providerId, 128),
    model: optStr(raw.model, 256),
    runId: optStr(raw.runId, 128),
    // Frames an image run asked for; the node settles when that many landed or failed.
    frameCount: Number.isInteger(raw.frameCount) ? Math.max(0, Math.min(raw.frameCount, RECIPE_LIMITS.frames)) : 0,
    jobIds: idList(raw.jobIds, RECIPE_LIMITS.frames),
    failedJobIds: idList(raw.failedJobIds, RECIPE_LIMITS.frames),
    // Frames point at the panel's takes; a removed take drops out.
    takeIds: idList(raw.takeIds, RECIPE_LIMITS.frames).filter((id) => takeIds.has(id)),
    excludedRefs: idList(raw.excludedRefs, 40, IMAGE_NAME_PATTERN),
    extraRefs: imageList(raw.extraRefs),
    // The reference images an image run sent, beside its exact prompt.
    sentRefs: imageList(raw.sentRefs),
    // A redraw-all run selects its frame when it lands. Transient: a peer
    // that drops it only leaves the selection where it was.
    selectOnLand: raw.selectOnLand === true,
    runAt: typeof raw.runAt === 'string' && Number.isFinite(Date.parse(raw.runAt)) ? raw.runAt : null,
  };
}

/** Normalize `panel.make` against the panel's takes; null when empty. */
export function sanitizePanelMake(raw, takeIds = new Set()) {
  if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') return null;
  const nodes = {};
  for (const [nodeId, state] of Object.entries(raw.nodes).slice(0, RECIPE_LIMITS.nodes)) {
    if (!NODE_ID_PATTERN.test(nodeId)) continue;
    const clean = sanitizeNodeState(state, takeIds);
    if (clean) nodes[nodeId] = clean;
  }
  return Object.keys(nodes).length ? { nodes } : null;
}
