/**
 * Music Video — Cast & Sets image plan (pure): which reference images the
 * check-in needs, the prompt for each, what each one is conditioned on, which
 * ones a revision has to redo, and what the approved result becomes on the
 * project (visual-spec references + concept subjects).
 *
 * The prompts generalize the hand-made check-in's templates:
 *   - `character`   — the canonical five-view character sheet. First, and every
 *                     image of the protagonist after it uses it as reference #1.
 *                     Its own references are the mood-board images the
 *                     direction picked.
 *   - `expressions` — a 2×3 expression sheet including the signature gesture.
 *   - `looks`       — the wardrobe lookbook, one panel per look.
 *   - `set:<id>`    — one EMPTY plate per set (no people), conditioned on the
 *                     mood board for look only; plates do not depend on the
 *                     character, so they render alongside it.
 *   - `test:<n>`    — the protagonist in a set: conditioned on that set's plate,
 *                     the character sheet and the looks sheet.
 *
 * A `procedural` direction (see castAndSetsDirection.js) plans none of the
 * photographic sheets, expression/looks sheets or tests: the characters are
 * built in code, so the only images are the set plates, each with an
 * intentional `role` (background, texture, decoration or cutout) that shapes
 * its prompt. A code-only project plans no images at all.
 */

import { trimTo } from '../../lib/textUtils.js';
import { songSections } from './castAndSetsDirection.js';

export const CAST_SETS_IMAGE_SIZE = Object.freeze({ width: 1536, height: 1024 });
// Mirrors MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES / the visual spec's list cap.
const MAX_CONDITIONING = 4;
const MAX_REFERENCES = 24;
const MAX_SUBJECTS = 24;
export const CAST_SETS_REF_PREFIX = 'mvr-cs-';
export const CAST_SETS_SUBJECT_PREFIX = 'cs-';

// Only the medium is fixed; the look (film stock, light, texture) comes from
// the project's own mood board / style via `direction.look`.
const PHOTO = 'photorealistic, editorial photography';
const sentence = (s) => {
  const t = String(s || '').trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};
const join = (...parts) => parts.map(sentence).filter(Boolean).join(' ');

function identity(p) {
  return [p.face && `face: ${p.face}`, p.hair && `hair: ${p.hair}`].filter(Boolean).join('; ');
}

function rulesLine(p) {
  return (p.rules || []).length ? `Rules: ${p.rules.join('; ')}` : '';
}

/** How much of the song each set covers, in seconds (for ordering / conditioning). */
export function setCoverage(project, direction) {
  const sections = songSections(project);
  const bySection = new Map(sections.map((s) => [s.index, s.endSec - s.startSec]));
  const cover = new Map((direction?.sets || []).map((s) => [s.id, 0]));
  for (const entry of direction?.songMap || []) {
    if (cover.has(entry.setId)) cover.set(entry.setId, cover.get(entry.setId) + (bySection.get(entry.section) || 0));
  }
  return cover;
}

/** The in-set tests to render: the direction's own, topped up to two from the most-used sets. A procedural direction has none. */
export function plannedTests(project, direction) {
  if (direction?.medium === 'procedural') return [];
  const tests = (direction?.tests || []).slice(0, 4);
  if (tests.length >= 2) return tests;
  const cover = setCoverage(project, direction);
  const ranked = [...(direction?.sets || [])].sort((a, b) => (cover.get(b.id) || 0) - (cover.get(a.id) || 0));
  const look = direction?.looks?.[0]?.name || '';
  for (const set of ranked) {
    if (tests.length >= 2) break;
    if (tests.some((t) => t.setId === set.id)) continue;
    tests.push({ setId: set.id, look, action: 'performing the song straight to camera', caption: set.sections?.[0] || set.name });
  }
  return tests;
}

const PROCEDURAL_ROLE_PROMPTS = {
  background: (set) => join('Layered illustration background plate for a code-animated music video, flat graphic shading, no characters, no text', set.description),
  texture: (set) => join('Seamless tileable surface texture, flat even light, no objects, no characters, no text', set.description),
  decoration: (set) => join('A single isolated decorative element centered on a plain flat backdrop with generous margin, no text', set.description),
  cutout: (set) => join('A single isolated subject on a plain flat backdrop with clean edges, ready to cut out and composite, no text', set.description),
};

/** The procedural plan: one role-prompted plate per set, no photographic character work. */
function buildProceduralImagePlan(direction, { revisionNotes = {} } = {}) {
  const style = trimTo(direction.look, 500);
  const world = direction.world || {};
  const plan = {};
  for (const set of direction.sets || []) {
    const key = `set:${set.id}`;
    const role = set.imageRole || 'background';
    plan[key] = {
      key,
      kind: 'plate',
      role,
      label: set.name,
      setId: set.id,
      deps: [],
      refKeys: [],
      moodRefs: true,
      prompt: join(
        (PROCEDURAL_ROLE_PROMPTS[role] || PROCEDURAL_ROLE_PROMPTS.background)(set),
        set.lighting && `Lighting: ${set.lighting}`,
        role === 'background' && world.depth && `Depth: ${world.depth}`,
        style && `Look: ${style}`,
        revisionNotes[key] && `Revision: ${revisionNotes[key]}`,
      ),
    };
  }
  return plan;
}

/**
 * Build the full image plan for a direction: `{ [key]: { key, kind, label,
 * prompt, deps, refKeys, setId?, testIndex? } }`. `refKeys` name other plan
 * keys whose image is passed as a reference (in order); `moodRefs` adds the
 * chosen mood-board images. A revision note for a key is appended to its prompt.
 */
export function buildCastAndSetsImagePlan(project, direction, { revisionNotes = {} } = {}) {
  if (direction.medium === 'procedural') return buildProceduralImagePlan(direction, { revisionNotes });
  const p = direction.protagonist || {};
  const looks = direction.looks || [];
  const firstLook = looks[0];
  const style = trimTo(direction.look, 500) || trimTo(project?.concept?.style, 500);
  const firstLight = direction.sets?.[0]?.lighting || '';
  const note = (key) => (revisionNotes[key] ? `Revision: ${revisionNotes[key]}` : '');
  const plan = {};

  plan.character = {
    key: 'character',
    kind: 'character',
    label: 'Character sheet',
    deps: [],
    refKeys: [],
    moodRefs: true,
    prompt: join(
      `Photographic character reference sheet of ONE consistent person, ${p.name || 'the protagonist'}: ${p.description || ''}`,
      identity(p),
      p.signature && `Signature detail, always visible: ${p.signature}`,
      firstLook && `Wearing ${firstLook.description}`,
      rulesLine(p),
      'Five views on a seamless dark grey backdrop: FRONT, 3/4, PROFILE, BACK full-body, plus a FACE close-up, with small typewriter captions',
      style && `Look: ${style}`,
      `${PHOTO}, even studio light, lookbook realism`,
      note('character'),
    ),
  };

  plan.expressions = {
    key: 'expressions',
    kind: 'expressions',
    label: 'Expression sheet',
    deps: ['character'],
    refKeys: ['character'],
    prompt: join(
      'Photographic expression sheet, 2 rows x 3 columns grid of tight close-ups of the SAME person as the character reference',
      identity(p),
      `Panels: 1) singing full-voice with mouth wide open, eyes closed; 2) whispering close to the lens; 3) sly half-smile, eyes locked on camera; 4) ${p.gesture || 'a signature gesture toward the camera'}; 5) fingertips at parted lips, eyes half-lidded; 6) head tilted back, eyes shut`,
      'Consistent identity across all panels',
      firstLight && `Light: ${firstLight}`,
      style && `Look: ${style}`,
      `${PHOTO}, thin black gutters between panels, no text`,
      note('expressions'),
    ),
  };

  plan.looks = {
    key: 'looks',
    kind: 'looks',
    label: 'Looks',
    deps: ['character'],
    refKeys: ['character'],
    prompt: join(
      `Fashion lookbook sheet of the SAME person as the character reference, ${looks.length} full-body panels side by side`,
      identity(p),
      rulesLine(p),
      ...looks.map((l, i) => `LOOK 0${i + 1} ${l.name.toUpperCase()}: ${l.description}${p.signature ? `, with ${p.signature}` : ''}`),
      `Seamless dark grey backdrop, typewriter captions ${looks.map((l, i) => `LOOK 0${i + 1} ${l.name.toUpperCase()}`).join(', ')}`,
      style && `Look: ${style}`,
      `${PHOTO}, lookbook realism`,
      note('looks'),
    ),
  };

  for (const set of direction.sets || []) {
    const key = `set:${set.id}`;
    plan[key] = {
      key,
      kind: 'plate',
      label: set.name,
      setId: set.id,
      deps: [],
      refKeys: [],
      moodRefs: true,
      prompt: join(
        'Empty set plate, no people',
        set.description,
        set.lighting && `Lighting: ${set.lighting}`,
        style && `Look: ${style}`,
        'Photorealistic music video location still',
        note(key),
      ),
    };
  }

  plannedTests(project, direction).forEach((test, i) => {
    const set = (direction.sets || []).find((s) => s.id === test.setId);
    const look = looks.find((l) => l.name === test.look) || firstLook;
    const key = `test:${i + 1}`;
    plan[key] = {
      key,
      kind: 'test',
      label: test.caption || set?.name || `Test ${i + 1}`,
      setId: test.setId,
      testIndex: i,
      deps: ['character', `set:${test.setId}`, 'looks'].filter((k) => plan[k]),
      refKeys: [`set:${test.setId}`, 'character', 'looks'].filter((k) => plan[k]),
      prompt: join(
        `Photorealistic music video still, wide 16:9. Recreate the ${set?.name || 'set'} from the set plate reference, same camera angle and light`,
        `Place the person from the character sheet in it (${identity(p)})`,
        look && `Wearing ${look.description}`,
        test.action,
        set?.lighting && `Light: ${set.lighting}`,
        style && `Look: ${style}`,
        note(key),
      ),
    };
  });

  return plan;
}

/**
 * The plan keys a revised direction must re-render: a key whose prompt or
 * references changed, plus everything that depends on a re-rendered key.
 * `force` adds keys the director flagged directly.
 */
export function affectedImageKeys(previousPlan, nextPlan, force = []) {
  const out = new Set(force.filter((k) => nextPlan[k]));
  for (const [key, item] of Object.entries(nextPlan)) {
    const before = previousPlan?.[key];
    if (!before || before.prompt !== item.prompt || before.refKeys.join('|') !== item.refKeys.join('|')) out.add(key);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, item] of Object.entries(nextPlan)) {
      if (!out.has(key) && item.deps.some((d) => out.has(d))) { out.add(key); grew = true; }
    }
  }
  return [...out];
}

/** Map a note target ('character', 'set:<id>', 'test:2', 'looks', …) to plan keys; null for a direction-level note. */
export function noteImageKeys(target, plan) {
  if (!target) return null;
  const t = String(target).trim().toLowerCase();
  if (plan[t]) return [t];
  if (t === 'protagonist' || t === 'cast') return ['character'];
  if (t === 'wardrobe') return ['looks'];
  if (t === 'expression') return ['expressions'];
  const bySetName = Object.values(plan).find((item) => item.kind === 'plate' && item.label.toLowerCase() === t);
  return bySetName ? [bySetName.key] : null;
}

// ---- applying an approved result ---------------------------------------------

/**
 * The visual-spec references the approved check-in contributes: the character
 * sheet (conditioning) first, then set plates by song coverage (conditioning
 * while the backend's reference cap allows, after any the director flagged
 * themselves), then the looks and expression sheets as unconditioned
 * reference. Replaces any earlier Cast & Sets references; keeps the director's.
 */
export function castAndSetsReferences(project, stage) {
  const existing = (project?.visualSpec?.references || []).filter((r) => !String(r.id || '').startsWith(CAST_SETS_REF_PREFIX));
  let budget = Math.max(0, MAX_CONDITIONING - existing.filter((r) => r.condition).length);
  let room = Math.max(0, MAX_REFERENCES - existing.length);
  const images = stage?.images || {};
  const direction = stage?.direction || {};
  const out = [];
  const push = (ref, wantsCondition) => {
    if (!ref.imageId || room <= 0) return;
    const condition = wantsCondition && budget > 0;
    if (condition) budget -= 1;
    room -= 1;
    out.push({ ...ref, condition, use: 'reference' });
  };
  const p = direction.protagonist || {};
  push({ id: `${CAST_SETS_REF_PREFIX}character`, imageId: images.character?.imageId, role: 'character', label: `${p.name || 'Protagonist'} — character sheet`, note: trimTo([p.face, p.hair, p.signature].filter(Boolean).join('; '), 1000) }, true);
  const cover = setCoverage(project, direction);
  const plates = [...(direction.sets || [])].sort((a, b) => (cover.get(b.id) || 0) - (cover.get(a.id) || 0));
  for (const set of plates) {
    // A procedural texture, decoration or cutout is a loose asset, not a look to condition frames on.
    const conditions = direction.medium !== 'procedural' || (set.imageRole || 'background') === 'background';
    push({ id: `${CAST_SETS_REF_PREFIX}set-${set.id}`.slice(0, 64), imageId: images[`set:${set.id}`]?.imageId, role: 'set', label: trimTo(set.name, 120), note: trimTo([set.description, set.lighting].filter(Boolean).join(' — '), 1000) }, conditions);
  }
  push({ id: `${CAST_SETS_REF_PREFIX}looks`, imageId: images.looks?.imageId, role: 'wardrobe', label: 'Looks', note: trimTo((direction.looks || []).map((l) => l.name).join(', '), 1000) }, false);
  push({ id: `${CAST_SETS_REF_PREFIX}expressions`, imageId: images.expressions?.imageId, role: 'character', label: 'Expression sheet', note: trimTo(p.gesture, 1000) }, false);
  return [...existing, ...out];
}

/**
 * The concept subjects the check-in seeds: the protagonist and one place per
 * set. A subject the director authored (any id outside the `cs-` namespace)
 * is never replaced, and a Cast & Sets subject whose name matches one of the
 * director's is left out rather than duplicated.
 */
export function castAndSetsSubjects(project, stage) {
  const authored = (project?.concept?.subjects || []).filter((s) => !String(s.id || '').startsWith(CAST_SETS_SUBJECT_PREFIX));
  const taken = new Set(authored.map((s) => `${s.kind}:${String(s.name || '').trim().toLowerCase()}`));
  const direction = stage?.direction || {};
  const p = direction.protagonist || {};
  const ours = [];
  if (p.name) {
    ours.push({
      id: `${CAST_SETS_SUBJECT_PREFIX}protagonist`,
      kind: 'character',
      name: trimTo(p.name, 120),
      description: trimTo([p.description, p.construction, p.shapeLanguage, p.materials, p.palette, p.face, p.hair, p.signature].filter(Boolean).join('; '), 1000),
      role: 'protagonist',
    });
  }
  for (const set of direction.sets || []) {
    ours.push({
      id: `${CAST_SETS_SUBJECT_PREFIX}set-${set.id}`.slice(0, 64),
      kind: 'place',
      name: trimTo(set.name, 120),
      description: trimTo([set.description, set.lighting && `Light: ${set.lighting}`].filter(Boolean).join(' '), 1000),
    });
  }
  const fresh = ours.filter((s) => s.name && !taken.has(`${s.kind}:${s.name.toLowerCase()}`));
  return [...authored, ...fresh].slice(0, MAX_SUBJECTS);
}
