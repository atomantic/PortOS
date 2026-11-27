/** Normalize and merge partial Cast & Sets responses while retaining absent fields. */
import { trimTo } from '../../lib/textUtils.js';
import { CAST_SETS_IMAGE_ROLES, CAST_SETS_LIMITS, TEXT } from './castAndSetsDirectionLimits.js';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const hasOwn = (obj, key) => obj != null && Object.hasOwn(obj, key);

const normalizeRole = (role) => {
  const r = String(role || '').trim().toLowerCase();
  return CAST_SETS_IMAGE_ROLES.includes(r) ? r : 'background';
};

function normalizeSets(sets, sections, procedural = false) {
  const seen = new Set();
  const labels = new Map(sections.map((s) => [String(s.index), s.label]));
  return sets.filter((s) => s.name && s.description).slice(0, CAST_SETS_LIMITS.sets.max).map((s, i) => {
    let id = slug(s.id) || slug(s.name) || `set-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const rawSections = Array.isArray(s.sections) ? s.sections : (typeof s.sections === 'string' ? s.sections.split(/[,;]/) : []);
    return {
      id,
      name: s.name,
      description: s.description,
      lighting: s.lighting || '',
      // A memory set's period and film stock; present-story sets keep their legacy shape.
      ...(!procedural && s.era ? { era: s.era } : {}),
      ...(!procedural && s.look ? { look: s.look } : {}),
      ...(procedural ? { imageRole: normalizeRole(s.imageRole) } : {}),
      sections: rawSections.map((x) => (typeof x === 'number' ? labels.get(String(x)) || '' : String(x).trim())).filter(Boolean).slice(0, 12),
    };
  });
}

function normalizeSongMap(entries, sets, sections) {
  const setIds = new Set(sets.map((s) => s.id));
  const bySlug = new Map(sets.map((s) => [slug(s.name), s.id]));
  const byLabel = new Map(sections.map((s) => [s.label.toLowerCase(), s.index]));
  const out = new Map();
  for (const entry of entries) {
    const index = typeof entry.section === 'number' ? entry.section : (byLabel.get(String(entry.section).trim().toLowerCase()) ?? Number(entry.section));
    const setId = setIds.has(slug(entry.setId)) ? slug(entry.setId) : bySlug.get(slug(entry.setId));
    if (!Number.isInteger(index) || !sections.some((s) => s.index === index) || !setId) continue;
    if (!out.has(index)) out.set(index, { section: index, setId });
  }
  return [...out.values()].sort((a, b) => a.section - b.section);
}

export const castKey = (name) => String(name || '').trim().toLowerCase();

// Supporting cast: a named person with something to draw (face or description),
// unique slug ids, never the protagonist again. Each `fixed` subject (the
// director's catalog-linked supporting characters) is kept once by name beyond
// the invented-cast cap; one the answer left out (or left undrawable) is added
// from its catalog description, unless it is the protagonist or a bound age form.
// Identity here is the name on purpose: fixedCasting pulls each subject's image
// by reference label, sheets and shot conditioning match a cast member by name,
// and a fixed subject sharing the protagonist's name is the one the direction
// cast as the protagonist. Two same-named subjects are one person to all of them.
function normalizeCast(cast, protagonist, { fixed = [], forms = [] } = {}) {
  const seen = new Set();
  const lead = castKey(protagonist?.name);
  const fixedNames = new Set(fixed.map((f) => castKey(f.name)));
  // A fixed subject bound to a protagonist age form is that form, never also supporting cast.
  const bound = new Set(forms.map((f) => f.subjectId).filter(Boolean));
  const boundNames = new Set(fixed.filter((f) => bound.has(f.id)).map((f) => castKey(f.name)));
  const placed = new Set([lead, ...boundNames]);
  let invented = 0;
  const kept = cast.filter((c) => {
    const key = castKey(c.name);
    if (!key || !(c.face || c.description) || key === lead || boundNames.has(key)) return false;
    if (fixedNames.has(key)) {
      if (placed.has(key)) return false;
      placed.add(key);
      return true;
    }
    if (invented >= CAST_SETS_LIMITS.cast) return false;
    invented += 1;
    return true;
  });
  const added = fixed.filter((f) => {
    const key = castKey(f.name);
    if (placed.has(key)) return false;
    placed.add(key);
    return true;
  }).map((f) => ({ name: f.name, role: f.role === 'band' ? 'band member' : '', description: trimTo(f.description, TEXT) }));
  return [...kept, ...added].map((c, i) => {
    let id = slug(c.id) || slug(c.name) || `cast-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { id, name: c.name, role: c.role || '', description: c.description || '', face: c.face || '', hair: c.hair || '', wardrobe: c.wardrobe || '',
      ...(c.height ? { height: c.height } : {}),
      ...(c.stillness ? { stillness: c.stillness } : {}), ...(c.movement ? { movement: c.movement } : {}) };
  });
}

// Recurring objects: described, unique slug ids, capped; the director's catalog
// objects (`fixed`) are added by name when the answer left one out.
export function normalizeProps(props, { fixed = [] } = {}) {
  const seen = new Set();
  const kept = (Array.isArray(props) ? props : []).filter((p) => p && p.name && p.description);
  const named = new Set(kept.map((p) => String(p.name).trim().toLowerCase()));
  const added = fixed.filter((p) => p.name && !named.has(p.name.toLowerCase()))
    .map((p) => ({ name: p.name, description: p.description || p.name }));
  return [...added, ...kept].slice(0, CAST_SETS_LIMITS.props).map((p, i) => {
    let id = slug(p.id) || slug(p.name) || `prop-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    return { id, name: p.name, owner: p.owner || '', description: p.description };
  });
}

// Other ages of the protagonist: a described form, unique slug ids, capped.
// `subjectId` (optional) binds the form to a fixed-casting subject's reference;
// a form listed without the key keeps the binding `previous` had for its id.
export function normalizeForms(forms, previous = []) {
  const seen = new Set();
  return (Array.isArray(forms) ? forms : []).filter((f) => f && (f.label || f.age) && f.description)
    .slice(0, CAST_SETS_LIMITS.forms).map((f, i) => {
      let id = slug(f.id) || slug(f.label) || slug(f.age && `age-${f.age}`) || `form-${i + 1}`;
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      const prior = previous.find((p) => p?.id === id);
      const subjectId = String((hasOwn(f, 'subjectId') ? f.subjectId : prior?.subjectId) || '').trim().slice(0, 64);
      // The bound subject's name (stamped by the service), kept while the binding is.
      const subjectName = subjectId && String((subjectId === prior?.subjectId && prior?.subjectName) || f.subjectName || '').trim().slice(0, 120);
      return { id, label: f.label || `Age ${f.age}`, age: f.age || '', description: f.description, hair: f.hair || '', wardrobe: f.wardrobe || '',
        ...((hasOwn(f, 'renderingMedium') || hasOwn(prior, 'renderingMedium'))
          ? { renderingMedium: hasOwn(f, 'renderingMedium') ? f.renderingMedium : prior.renderingMedium } : {}),
        ...(f.height ? { height: f.height } : {}), ...(f.era ? { era: f.era } : {}), ...(f.look ? { look: f.look } : {}),
        ...(subjectId ? { subjectId } : {}), ...(subjectName ? { subjectName } : {}) };
    });
}

// A test naming a form shows the protagonist at that age; one naming a form the
// direction no longer has is dropped, never re-cast as the present-day protagonist.
function normalizeTests(tests, sets, looks, forms = []) {
  const setIds = new Set(sets.map((s) => s.id));
  const formIds = new Set(forms.map((f) => f.id));
  return tests
    .map((t) => ({ ...t, setId: slug(t.setId), formId: typeof t.formId === 'string' ? t.formId.trim() : '' }))
    .filter((t) => setIds.has(t.setId) && t.action && (!t.formId || formIds.has(t.formId)))
    .slice(0, CAST_SETS_LIMITS.tests.max)
    .map((t) => ({
      setId: t.setId,
      look: looks.find((l) => l.name.toLowerCase() === String(t.look || '').toLowerCase())?.name || looks[0]?.name || '',
      action: t.action,
      caption: t.caption || '',
      ...(t.formId ? { formId: t.formId } : {}),
    }));
}

function mergeProtagonist(p0, p1, procedural) {
  const pField = (key) => (hasOwn(p1, key) ? p1[key] : (p0[key] ?? ''));
  const protagonist = {
    name: pField('name'),
    description: pField('description'),
    face: pField('face'),
    hair: pField('hair'),
    signature: pField('signature'),
    gesture: pField('gesture'),
    rules: (hasOwn(p1, 'rules') ? p1.rules : (p0.rules || [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.rules),
  };
  // Optional so a protagonist without one keeps its legacy shape.
  if (!procedural && pField('height')) protagonist.height = pField('height');
  if (pField('stillness')) protagonist.stillness = pField('stillness');
  if (!procedural && pField('movement')) protagonist.movement = pField('movement');
  const expressions = (hasOwn(p1, 'expressions') ? p1.expressions : (p0.expressions || [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.expressions);
  const forms = procedural ? [] : normalizeForms(hasOwn(p1, 'forms') ? p1.forms : p0.forms, p0.forms || []);
  // A photographic protagonist without moods or other ages keeps its legacy shape
  // (its seeded Cast guide still reads as the same content).
  if (procedural || expressions.length) protagonist.expressions = expressions;
  if (forms.length) protagonist.forms = forms;
  if (procedural) {
    Object.assign(protagonist, {
      construction: pField('construction'),
      shapeLanguage: pField('shapeLanguage'),
      materials: pField('materials'),
      palette: pField('palette'),
      movement: pField('movement'),
    });
  }
  return { protagonist, forms };
}

/**
 * Merge a parsed (partial) answer onto the current direction and normalize
 * the result. Absent keys keep `previous`; present keys replace (an empty
 * string/array clears the optional text/list fields). `fixedCast` is the
 * project's fixedSupportingCast: each stays in the cast (see normalizeCast). Returns
 * `{ direction, missing }` — `missing` lists the required parts still absent,
 * so a first pass with an unusable answer can be refused.
 */
export function mergeCastAndSetsDirection(previous, parsed, { sections = [], medium = null, minSets = CAST_SETS_LIMITS.sets.min, fixedCast = [], fixedProps: fixedPropList = [] } = {}) {
  const base = previous || {};
  const procedural = (medium || base.medium) === 'procedural';
  const pick = (key, fallback) => (hasOwn(parsed, key) ? parsed[key] : (hasOwn(base, key) ? base[key] : fallback));
  const { protagonist, forms } = mergeProtagonist(base.protagonist || {}, hasOwn(parsed, 'protagonist') ? parsed.protagonist : {}, procedural);
  const w0 = base.world || {};
  const w1 = hasOwn(parsed, 'world') ? parsed.world : {};
  const wField = (key) => (hasOwn(w1, key) ? w1[key] : (w0[key] ?? ''));
  const world = { layout: wField('layout'), depth: wField('depth'), lighting: wField('lighting'), camera: wField('camera'), transitions: wField('transitions') };
  const looks = (pick('looks', [])).filter((l) => l.name && l.description).slice(0, CAST_SETS_LIMITS.looks.max)
    .map((l) => ({ name: l.name, description: l.description, chapters: l.chapters || '' }));
  const sets = (hasOwn(parsed, 'sets') ? normalizeSets(parsed.sets, sections, procedural) : (base.sets || [])).map((set) => {
    const prior = base.sets?.find((s) => s.id === set.id);
    return prior?.setReference ? { ...set, setReference: prior.setReference } : set;
  });
  const songMap = normalizeSongMap(pick('songMap', []), sets, sections);
  const tests = normalizeTests(pick('tests', []), sets, looks, forms);
  const overlayRaw = pick('overlayConcept', { summary: '', elements: [] }) || {};
  const overlayConcept = {
    summary: overlayRaw.summary || '',
    elements: (overlayRaw.elements || []).filter((e) => e.name && e.description).slice(0, CAST_SETS_LIMITS.overlayElements)
      .map((e) => ({ name: e.name, description: e.description })),
  };
  const definitions = hasOwn(parsed, 'definitions') ? parsed.definitions : (base.definitions || { characters: [] });
  const cast = pick('cast', []).map((person) => {
    const prior = (person.id && (base.cast || []).find((c) => c.id === person.id))
      || (base.cast || []).find((c) => castKey(c.name) === castKey(person.name));
    return { ...person, ...Object.fromEntries(['stillness', 'movement'].filter((key) => !hasOwn(person, key) && prior?.[key]).map((key) => [key, prior[key]])) };
  });
  const direction = {
    ...(procedural ? { medium: 'procedural', world, definitions } : {}),
    logline: pick('logline', ''),
    interpretation: pick('interpretation', ''),
    look: pick('look', ''),
    ...((hasOwn(parsed, 'renderingMedium') || hasOwn(base, 'renderingMedium'))
      ? { renderingMedium: pick('renderingMedium', '') } : {}),
    // A new photographic direction uses the standard people sheet; an older one
    // keeps its five-view sheet until the director switches it (castAndSetsPlan.js).
    ...(!procedural && (!previous || hasOwn(parsed, 'sheetLayout') || hasOwn(base, 'sheetLayout'))
      ? { sheetLayout: pick('sheetLayout', 'standard') } : {}),
    protagonist,
    looks,
    // Procedural directions created before cast prose existed keep their shape.
    ...(!procedural || hasOwn(parsed, 'cast') || hasOwn(base, 'cast')
      ? { cast: normalizeCast(cast, protagonist, { fixed: fixedCast, forms }) } : {}),
    // Photographic only; a direction saved before props existed keeps its shape.
    ...(!procedural && (hasOwn(parsed, 'props') || base.props || fixedPropList.length)
      ? { props: normalizeProps(pick('props', []), { fixed: fixedPropList }) } : {}),
    sets,
    songMap,
    tests,
    overlayConcept,
    questions: (pick('questions', [])).filter(Boolean).slice(0, CAST_SETS_LIMITS.questions),
    // The director edited the tests: plannedTests stops topping them up.
    ...(pick('testsFixed', false) ? { testsFixed: true } : {}),
  };
  const missing = [
    !direction.logline && 'logline',
    !(protagonist.name && (protagonist.face || protagonist.description || protagonist.construction)) && 'protagonist',
    !procedural && looks.length < CAST_SETS_LIMITS.looks.min && 'looks',
    sets.length < minSets && 'sets',
  ].filter(Boolean);
  return { direction, missing };
}
