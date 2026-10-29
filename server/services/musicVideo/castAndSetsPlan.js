/**
 * Music Video — Cast & Sets image plan (pure): which reference images the
 * check-in needs, the prompt for each, what each one is conditioned on, which
 * ones a revision has to redo, and what the approved result becomes on the
 * project (visual-spec references + concept subjects).
 *
 * The prompts generalize the hand-made check-in's templates:
 *   - `character`   — the canonical five-view character sheet. First, and every
 *                     image of the protagonist after it uses it as reference #1.
 *                     Its references are the director's own character
 *                     identity images (`refImages`); mood board images are
 *                     outside inspiration and only reach it as text.
 *   - `expressions` — an expression sheet of the moods the direction found in
 *                     the story (`protagonist.expressions`); a direction saved
 *                     before those existed keeps the 2×3 performance sheet.
 *   - `form:<id>`   — one more character sheet per other age the story shows
 *                     the protagonist at, conditioned on the canonical sheet and,
 *                     when the form is bound to a fixed-casting subject
 *                     (`form.subjectId`), on that subject's own reference image.
 *   - `looks`       — the wardrobe lookbook, one panel per look.
 *   - `set:<id>`    — one EMPTY plate per set: any sentence of the description,
 *                     lighting or look that puts a person in it is dropped. Plates do
 *                     not depend on the character, so they render alongside it.
 *   - `test:<n>`    — the protagonist in a set: conditioned on that set's plate,
 *                     the character sheet and the looks sheet — or, for a test
 *                     at another age (`test.formId`), that age's form sheet.
 *
 * A `procedural` direction (see castAndSetsDirection.js) plans none of the
 * photographic sheets, expression/looks sheets or tests: the characters are
 * built in code, so the only images are the set plates, each with an
 * intentional `role` (background, texture, decoration or cutout) that shapes
 * its prompt. A code-only project plans no images at all.
 */

import { trimTo } from '../../lib/textUtils.js';
import { isOutsideMusicVideoReference } from '../../lib/musicVideoConditioning.js';
// A sentence naming a person or the protagonist puts someone in an empty plate.
import { withoutPeople } from '../../lib/musicVideoCreativeContext.js';
import { CAST_SETS_SUBJECT_PREFIX, fixedCasting, formSubjects, leadingAge, musicVideoLipSyncs, songSections, subjectNameParts } from './castAndSetsDirection.js';

export const CAST_SETS_IMAGE_SIZE = Object.freeze({ width: 1536, height: 1024 });
// Mirrors MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES / the visual spec's list cap.
const MAX_CONDITIONING = 4;
const MAX_REFERENCES = 24;
const MAX_SUBJECTS = 24;
export const CAST_SETS_REF_PREFIX = 'mvr-cs-';
export { CAST_SETS_SUBJECT_PREFIX };

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

/**
 * The director's own identity references for the protagonist: the project's
 * character references flagged to condition frames (their uploads or images
 * PortOS rendered), never a mood board import or Pinterest pin, and never an
 * earlier Cast & Sets output (the sheet would condition on itself).
 */
function identityImages(project, exclude = new Set()) {
  return [...new Set((project?.visualSpec?.references || [])
    .filter((r) => r?.role === 'character' && r.condition && r.imageId && !exclude.has(r.imageId)
      && !String(r.id || '').startsWith(CAST_SETS_REF_PREFIX) && !isOutsideMusicVideoReference(r))
    .map((r) => r.imageId))].slice(0, MAX_CONDITIONING);
}

/**
 * Each protagonist form's binding: `{ subjectId, images, imageId }` when it
 * names a fixed-casting subject with images (its Casting images, else the
 * reference labeled with its name, `imageId`), `{ subjectId, missing }` when
 * the subject is gone or unlinked (`'subject'`) or has none (`'image'`).
 * A missing binding conditions on nothing extra; it never borrows another image.
 */
function formBindings(project, forms, catalogLikeness) {
  const subjects = formSubjects(project);
  return new Map(forms.filter((f) => f.subjectId).map((f) => {
    const subject = subjects.find((s) => s.id === f.subjectId);
    if (!subject) return [f.id, { subjectId: f.subjectId, missing: 'subject', reserved: unlinkedSubjectImage(project, f) }];
    const catalog = catalogLikeness[subject.id]?.images || [];
    const images = (catalog.length ? catalog : [subject.imageId].filter(Boolean)).slice(0, MAX_CONDITIONING - 1);
    return [f.id, images.length ? { subjectId: f.subjectId, images, imageId: subject.imageId } : { subjectId: f.subjectId, missing: 'image' }];
  }));
}

// The reference still labeled for a bound subject that was since unlinked or
// removed (by the name recorded on the form): it shows that other age, so it
// stays off the present-day sheet too.
function unlinkedSubjectImage(project, form) {
  const subject = (project?.concept?.subjects || []).find((s) => s?.id === form.subjectId && s.kind === 'character');
  const name = String(subject?.name || form.subjectName || '').trim().toLowerCase();
  if (!name) return null;
  return (project?.visualSpec?.references || []).find((r) => r?.imageId && r.role === 'character' && String(r.label || '').trim().toLowerCase() === name)?.imageId || null;
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
  // A test at an age the direction no longer has is never re-cast as the adult.
  const formIds = new Set((direction?.protagonist?.forms || []).map((f) => f.id));
  const tests = (direction?.tests || []).filter((t) => !t.formId || formIds.has(t.formId)).slice(0, 4);
  // The director edited the list: what they kept is the plan.
  if (tests.length >= 2 || direction?.testsFixed) return tests;
  const cover = setCoverage(project, direction);
  const ranked = [...(direction?.sets || [])].sort((a, b) => (cover.get(b.id) || 0) - (cover.get(a.id) || 0));
  const look = direction?.looks?.[0]?.name || '';
  for (const set of ranked) {
    if (tests.length >= 2) break;
    if (tests.some((t) => t.setId === set.id)) continue;
    const action = musicVideoLipSyncs(project) ? 'performing the song straight to camera' : 'lost in a quiet moment, unaware of the camera';
    tests.push({ setId: set.id, look, action, caption: set.sections?.[0] || set.name });
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
function buildProceduralImagePlan(direction, { revisionNotes = {}, greyboxes = {} } = {}) {
  const style = withoutPeople(trimTo(direction.look, 500), direction.protagonist?.name);
  const world = direction.world || {};
  const plan = {};
  for (const set of direction.sets || []) {
    const key = `set:${set.id}`;
    const role = set.imageRole || 'background';
    // Only a cutout plate is meant to hold a subject.
    const clean = (text) => (role === 'cutout' ? text : withoutPeople(text, direction.protagonist?.name));
    const lighting = clean(set.lighting || '');
    plan[key] = {
      key,
      kind: 'plate',
      ...(set.setReference?.greyboxShotId ? { refImages: [greyboxes[set.id]?.reference.imageId].filter(Boolean) } : {}),
      role,
      label: set.name,
      setId: set.id,
      ...(set.setReference?.greyboxShotId ? { setReference: set.setReference } : {}),
      deps: [],
      refKeys: [],
      prompt: join(
        (PROCEDURAL_ROLE_PROMPTS[role] || PROCEDURAL_ROLE_PROMPTS.background)({ ...set, description: clean(set.description) || set.name }),
        lighting && `Lighting: ${lighting}`,
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
 * prompt, deps, refKeys, refImages?, setId?, testIndex? } }`. `refKeys` name
 * other plan keys whose image is passed as a reference (in order), then
 * `refImages` (a linked catalog record's Casting images, else the reference
 * labeled with its name, then the director's character identity images)
 * follow: only the project's and catalog's own images, never mood board
 * images. `catalogLikeness` is castAndSetsCatalogLikeness.js's result. A
 * revision note for a key is appended to its prompt.
 */
const expressionGrid = (n) => (n === 0 || n > 4 ? '2 rows x 3 columns' : n === 4 ? '2 rows x 2 columns' : `1 row x ${n} columns`);

export function buildCastAndSetsImagePlan(project, direction, { revisionNotes = {}, greyboxes = {}, catalogLikeness = {} } = {}) {
  if (direction.medium === 'procedural') return buildProceduralImagePlan(direction, { revisionNotes, greyboxes });
  const p = direction.protagonist || {};
  const looks = direction.looks || [];
  const firstLook = looks[0];
  const style = trimTo(direction.look, 500) || trimTo(project?.concept?.style, 500);
  const firstLight = direction.sets?.[0]?.lighting || '';
  const note = (key) => (revisionNotes[key] ? `Revision: ${revisionNotes[key]}` : '');
  const forms = p.forms || [];
  const bindings = formBindings(project, forms, catalogLikeness);
  const boundSubjects = new Set([...bindings.values()].map((b) => b.subjectId));
  // A linked catalog record's images (castAndSetsCatalogLikeness.js), else the
  // reference labeled with its name, condition the sheet or plate of the
  // protagonist, cast member or set the direction kept it as: by name, or by
  // the name without its age qualifier ("Nora (17)" is Nora), where the
  // protagonist prefers its own subject over one an age form is bound to.
  const fixed = fixedCasting(project);
  const baseName = (name) => subjectNameParts(name).base.toLowerCase();
  const fixedFor = (kind, name, { protagonist = false } = {}) => {
    const key = String(name || '').trim().toLowerCase();
    const ofKind = fixed.filter((f) => f.kind === kind);
    const exact = ofKind.find((f) => f.name.toLowerCase() === key);
    if (exact) return exact;
    const based = ofKind.filter((f) => baseName(f.name) === baseName(key));
    return (protagonist && (based.find((f) => f.role === 'protagonist') || based.find((f) => !boundSubjects.has(f.id)))) || based[0] || null;
  };
  const fixedImages = (f) => {
    const catalog = f && catalogLikeness[f.id]?.images;
    return (catalog?.length ? catalog : [f?.imageId].filter(Boolean)).slice(0, MAX_CONDITIONING);
  };
  const protagonistSubject = fixedFor('character', p.name, { protagonist: true });
  // An age-specific reference grounds its own form, never the present-day sheet.
  const formImages = new Set([...bindings.values()].map((b) => b.imageId || b.reserved).filter(Boolean));
  const identities = [...new Set([...fixedImages(protagonistSubject), ...identityImages(project, formImages)].filter((id) => id && !formImages.has(id)))].slice(0, MAX_CONDITIONING);
  // An age form no subject is bound to: that age's own Casting images of the protagonist's record.
  const protagonistForms = catalogLikeness[protagonistSubject?.id]?.forms || [];
  const ageImages = (form) => {
    const age = leadingAge(form.age);
    return age === null ? [] : (protagonistForms.find((f) => f.age === age)?.images || []).slice(0, MAX_CONDITIONING - 1);
  };
  const plan = {};

  plan.character = {
    key: 'character',
    kind: 'character',
    label: 'Character sheet',
    deps: [],
    refKeys: [],
    refImages: identities,
    prompt: join(
      `Photographic character reference sheet of ONE consistent person, ${p.name || 'the protagonist'}: ${p.description || ''}`,
      identities.length && 'The SAME person as the identity reference images: keep their face, hair and build exactly',
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

  const moods = (p.expressions || []).slice(0, 6);
  plan.expressions = {
    key: 'expressions',
    kind: 'expressions',
    label: 'Expression sheet',
    deps: ['character'],
    refKeys: ['character'],
    refImages: identities,
    prompt: join(
      `Photographic expression sheet, ${expressionGrid(moods.length)} grid of tight close-ups of the SAME person as the character reference`,
      identity(p),
      moods.length
        ? `Panels: ${moods.map((mood, i) => `${i + 1}) ${mood}`).join('; ')}`
        : musicVideoLipSyncs(project) ? `Panels: 1) singing full-voice with mouth wide open, eyes closed; 2) whispering close to the lens; 3) sly half-smile, eyes locked on camera; 4) ${p.gesture || 'a signature gesture toward the camera'}; 5) fingertips at parted lips, eyes half-lidded; 6) head tilted back, eyes shut`
          : 'Panels: 1) eyes closed, head bowed; 2) thoughtful gaze aside; 3) gentle smile; 4) quiet resolve; 5) eyes lowered; 6) head tilted back, eyes shut',
      !musicVideoLipSyncs(project) && 'Mouth closed in every panel: nobody is singing or speaking',
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
    refImages: identities,
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

  // Other ages: the same person younger or older, each on their own sheet,
  // conditioned on the canonical one so the face carries across the years.
  for (const form of forms) {
    const key = `form:${form.id}`;
    const binding = bindings.get(form.id);
    const formRefs = binding ? binding.images || [] : ageImages(form);
    plan[key] = {
      key,
      kind: 'form',
      label: `${p.name || 'Protagonist'} · ${form.label}`,
      formId: form.id,
      ...(binding ? { subjectId: binding.subjectId, ...(binding.missing ? { bindingMissing: binding.missing } : {}) } : {}),
      deps: ['character'],
      refKeys: ['character'],
      ...(formRefs.length ? { refImages: formRefs } : {}),
      prompt: join(
        `Photographic character reference sheet of ${p.name || 'the protagonist'}${form.age ? ` at age ${form.age}` : ''}: the SAME person as the character reference, at a different age`,
        formRefs.length && 'The SAME person as the age reference images: keep their face, hair and build at this age exactly',
        form.description,
        'Keep what does not change with age: eye color and shape, brows, skin tone, distinguishing marks',
        form.hair && `hair: ${form.hair}`,
        form.wardrobe && `Wearing ${form.wardrobe}`,
        rulesLine(p),
        'Five views on a seamless dark grey backdrop: FRONT, 3/4, PROFILE, BACK full-body, plus a FACE close-up, with small typewriter captions',
        style && `Look: ${style}`,
        `${PHOTO}, even studio light, lookbook realism`,
        note(key),
      ),
    };
  }

  // Supporting cast: each recurring person gets their own photographic sheet,
  // the same five views as the protagonist's, so shots naming them keep them.
  for (const c of direction.cast || []) {
    const key = `cast:${c.id}`;
    const castImages = fixedImages(fixedFor('character', c.name));
    plan[key] = {
      key,
      kind: 'cast',
      label: c.name,
      castId: c.id,
      deps: [],
      refKeys: [],
      ...(castImages.length ? { refImages: castImages } : {}),
      prompt: join(
        `Photographic character reference sheet of ONE consistent person, ${c.name}${c.role ? `, the ${c.role}` : ''}: ${c.description || ''}`,
        castImages.length && 'The SAME person as the reference images: keep their face, hair and build exactly',
        identity(c),
        c.wardrobe && `Wearing ${c.wardrobe}`,
        p.name && `A different person from ${p.name}`,
        'Five views on a seamless dark grey backdrop: FRONT, 3/4, PROFILE, BACK full-body, plus a FACE close-up, with small typewriter captions',
        style && `Look: ${style}`,
        `${PHOTO}, even studio light, lookbook realism`,
        note(key),
      ),
    };
  }

  const plateStyle = withoutPeople(style, p.name);
  for (const set of direction.sets || []) {
    const key = `set:${set.id}`;
    const plateLight = withoutPeople(set.lighting, p.name);
    const placeImages = greyboxes[set.id]?.reference.imageId ? [greyboxes[set.id].reference.imageId] : fixedImages(fixedFor('place', set.name));
    plan[key] = {
      key,
      kind: 'plate',
      label: set.name,
      setId: set.id,
      ...(set.setReference?.greyboxShotId ? { setReference: set.setReference } : {}),
      deps: [],
      refKeys: [],
      ...(placeImages.length ? { refImages: placeImages } : {}),
      prompt: join(
        'Empty set plate, no people',
        placeImages.length && 'The same location as the reference images',
        withoutPeople(set.description, p.name) || set.name,
        plateLight && `Lighting: ${plateLight}`,
        plateStyle && `Look: ${plateStyle}`,
        'Photorealistic music video location still',
        note(key),
      ),
    };
  }

  plannedTests(project, direction).forEach((test, i) => {
    const set = (direction.sets || []).find((s) => s.id === test.setId);
    const look = looks.find((l) => l.name === test.look) || firstLook;
    // A test at another age is that age's sheet in the set: the present-day
    // character and looks sheets would condition the wrong person.
    const form = test.formId ? forms.find((f) => f.id === test.formId) : null;
    const key = `test:${i + 1}`;
    plan[key] = {
      key,
      kind: 'test',
      label: test.caption || set?.name || `Test ${i + 1}`,
      setId: test.setId,
      testIndex: i,
      test: { ...test },
      deps: (form ? [`form:${form.id}`, `set:${test.setId}`] : ['character', `set:${test.setId}`, 'looks']).filter((k) => plan[k]),
      refKeys: (form ? [`set:${test.setId}`, `form:${form.id}`] : [`set:${test.setId}`, 'character', 'looks']).filter((k) => plan[k]),
      prompt: join(
        `Photorealistic music video still, wide 16:9. Recreate the ${set?.name || 'set'} from the set plate reference, same camera angle and light`,
        form
          ? `Place the person from the ${form.label} character sheet in it (${[form.age && `${p.name || 'the protagonist'} at age ${form.age}`, form.hair && `hair: ${form.hair}`].filter(Boolean).join('; ') || form.label})`
          : `Place the person from the character sheet in it (${identity(p)})`,
        form ? form.wardrobe && `Wearing ${form.wardrobe}` : look && `Wearing ${look.description}`,
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
    if (!before || before.prompt !== item.prompt || before.refKeys.join('|') !== item.refKeys.join('|')
      || (before.refImages || []).join('|') !== (item.refImages || []).join('|')) out.add(key);
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
  const byName = Object.values(plan).find((item) => ['plate', 'cast', 'form'].includes(item.kind) && item.label.toLowerCase() === t);
  return byName ? [byName.key] : null;
}

// ---- applying an approved result ---------------------------------------------

/**
 * The visual-spec references the approved check-in contributes: the character
 * sheet (conditioning) first, then set plates by song coverage (conditioning
 * while the backend's reference cap allows, after any the director flagged
 * themselves), then the supporting cast sheets (conditioning only the shots
 * that feature them), then the looks and expression sheets as unconditioned
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
  // Other-age sheets are reference only: a shot of the child is described in words and matched by eye.
  for (const form of p.forms || []) {
    push({ id: `${CAST_SETS_REF_PREFIX}form-${form.id}`.slice(0, 64), imageId: images[`form:${form.id}`]?.imageId, role: 'character', label: `${trimTo(p.name || 'Protagonist', 80)} — ${trimTo(form.label, 40)} sheet`, note: trimTo([form.age && `Age ${form.age}`, form.description, form.hair].filter(Boolean).join('; '), 1000) }, false);
  }
  // Cast sheets condition only the shots that feature them (musicVideoConditioningReferences).
  for (const c of direction.cast || []) {
    push({ id: `${CAST_SETS_REF_PREFIX}cast-${c.id}`.slice(0, 64), imageId: images[`cast:${c.id}`]?.imageId, role: 'character', label: `${trimTo(c.name, 80)} — cast sheet`, note: trimTo([c.role, c.face, c.hair, c.wardrobe].filter(Boolean).join('; '), 1000) }, false);
  }
  push({ id: `${CAST_SETS_REF_PREFIX}looks`, imageId: images.looks?.imageId, role: 'wardrobe', label: 'Looks', note: trimTo((direction.looks || []).map((l) => l.name).join(', '), 1000) }, false);
  push({ id: `${CAST_SETS_REF_PREFIX}expressions`, imageId: images.expressions?.imageId, role: 'character', label: 'Expression sheet', note: trimTo(p.gesture, 1000) }, false);
  return [...existing, ...out];
}

/**
 * The concept subjects the check-in seeds: the protagonist, each supporting
 * cast member and one place per set. A subject the director authored (any id
 * outside the `cs-` namespace) is never replaced, and a Cast & Sets subject whose name matches one of the
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
      description: trimTo([p.description, p.construction, p.shapeLanguage, p.materials, p.palette, p.face, p.hair, p.signature,
        (p.forms || []).length && `Also seen at: ${p.forms.map((f) => `${f.label} (${f.description})`).join('; ')}`].filter(Boolean).join('; '), 1000),
      role: 'protagonist',
    });
  }
  for (const c of direction.cast || []) {
    ours.push({
      id: `${CAST_SETS_SUBJECT_PREFIX}cast-${c.id}`.slice(0, 64),
      kind: 'character',
      name: trimTo(c.name, 120),
      description: trimTo([c.role, c.description, c.face, c.hair, c.wardrobe].filter(Boolean).join('; '), 1000),
      role: 'supporting',
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
  // A re-approval keeps each subject's catalog link and keep-local choice.
  const previous = new Map((project?.concept?.subjects || []).map((s) => [s.id, s]));
  const fresh = ours
    .filter((s) => s.name && !taken.has(`${s.kind}:${s.name.toLowerCase()}`))
    .map((s) => {
      const prior = previous.get(s.id);
      if (prior?.kind !== s.kind) return s;
      return { ...s, ...(prior.ingredientId ? { ingredientId: prior.ingredientId } : {}), ...(prior.castForm ? { castForm: prior.castForm } : {}), ...(prior.localOnly ? { localOnly: true } : {}) };
    });
  return [...authored, ...fresh].slice(0, MAX_SUBJECTS);
}
