/** Apply director edits to a saved Cast & Sets direction and describe revisions. */
import { ServerError } from '../../lib/errorHandler.js';
import { CAST_SETS_LIMITS, HEIGHT, SHORT, TEXT } from './castAndSetsDirectionLimits.js';
import { castKey, hasOwn, mergeCastAndSetsDirection, normalizeForms, normalizeProps } from './castAndSetsDirectionMerge.js';

/** The tests in `tests` whose form is not among `forms` (a 422 for a director edit). */
function testsWithMissingForm(tests, forms) {
  const formIds = new Set((forms || []).map((f) => f.id));
  return (tests || []).flatMap((t, i) => (t?.formId && !formIds.has(t.formId) ? [i + 1] : []));
}


// The fields the director can edit directly, with the caps the provider answer
// is held to. Procedural protagonists keep their construction fields; a
// photographic one its face, hair and signature.
export const CAST_SETS_EDITABLE_PROTAGONIST = Object.freeze({ construction: TEXT, shapeLanguage: 500, materials: 500, palette: 300, movement: TEXT });
export const CAST_SETS_EDITABLE_PHOTO_PROTAGONIST = Object.freeze({ name: SHORT, description: TEXT, height: HEIGHT, face: TEXT, hair: TEXT, signature: TEXT, gesture: TEXT });
export const CAST_SETS_EDITABLE_WORLD = Object.freeze({ layout: TEXT, depth: 500, lighting: 500, camera: 500, transitions: 500 });
const EDITABLE_CAST = Object.freeze({ name: SHORT, role: SHORT, description: TEXT, height: HEIGHT, face: TEXT, hair: TEXT, wardrobe: TEXT });
const EDITABLE_SET = Object.freeze({ name: SHORT, description: TEXT, lighting: 300, era: SHORT, look: 500 });
const EDITABLE_TEST = Object.freeze({ action: TEXT, caption: 300, look: SHORT });
// A test's form binding: a present `formId` replaces it (null or '' clears it).
const testFormPatch = (patch) => (hasOwn(patch, 'formId') ? { formId: patch.formId || '' } : {});

const pickText = (source, caps) => Object.fromEntries(
  Object.entries(caps).filter(([key]) => typeof source?.[key] === 'string').map(([key, max]) => [key, source[key].trim().slice(0, max)]),
);

const unknownItem = (what, ids) => new ServerError(`Unknown ${what}: ${ids.join(', ')}`, { status: 422, code: what === 'set' ? 'CAST_SETS_UNKNOWN_SET' : 'CAST_SETS_UNKNOWN_ITEM' });

/**
 * Apply per-item patches (`{ <key>, remove?, ...fields }`) to a list: a patch
 * with `remove` drops the item, any other replaces the text fields it names.
 * `keyOf(item, index)` names an item the way its patch does.
 */
function patchItems(list, patches, { what, keyOf, fields, extra = () => ({}) }) {
  const byKey = new Map(patches.map((p) => [String(p.key), p]));
  const known = new Set(list.map((item, i) => String(keyOf(item, i))));
  const unknown = [...byKey.keys()].filter((key) => !known.has(key));
  if (unknown.length) throw unknownItem(what, unknown);
  return list.flatMap((item, i) => {
    const patch = byKey.get(String(keyOf(item, i)));
    if (!patch) return [item];
    if (patch.remove) return [];
    return [{ ...item, ...pickText(patch, fields), ...extra(patch) }];
  });
}

function testLookPatches(tests, renamedLooks, currentLookNames, currentLookNamesExact) {
  return tests.map((test) => {
    if (test.remove) return { ...test, key: test.index };
    const name = test.look?.trim();
    let renamed = null;
    if (name && !currentLookNamesExact.has(name)) {
      const matches = [...renamedLooks].filter(([original]) => original.toLowerCase() === name.toLowerCase());
      if (currentLookNames.has(name.toLowerCase())) {
        if (matches.some(([, target]) => target && target.toLowerCase() !== name.toLowerCase())) {
          throw new ServerError('Look reference is ambiguous', { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
        }
      } else {
        renamed = renamedLooks.get(name);
        if (!renamed && matches.length > 1) throw new ServerError('Look reference is ambiguous', { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
        renamed ||= matches[0]?.[1];
      }
    }
    return { ...test, ...(renamed && { look: renamed }), key: test.index };
  });
}

/**
 * Apply the director's direct edits to a direction (either medium). `edits`:
 *   protagonist?: text fields (a present one replaces, '' clears, absent keeps),
 *                 `expressions` (the whole list), `forms` (the whole list, photographic);
 *   world?:       procedural world rules;
 *   looks?:       the whole wardrobe list;
 *   cast?:        `[{ id, remove?, name?, role?, description?, height?, face?, hair?, wardrobe? }]`;
 *   props?:       the whole prop list (`[{ id?, name, owner?, description }]`, photographic);
 *   sets?:        `[{ id, remove?, name?, description?, lighting?, era?, look?, imageRole? }]`, or
 *                 greybox selections only (`[{ id, setReference }]`, saved apart);
 *   tests?:       `[{ index (1-based), remove?, action?, caption?, look? }]` — an
 *                 edited test list is no longer topped up with automatic tests.
 * The result goes through the same merge + normalize as a provider answer, so
 * it can never be shaped differently from one; the director may cut the sets
 * down to one. Returns `{ direction, changed }` (`changed` names what actually
 * changed, for the revision record); throws 422 for an unknown item, an edit
 * that would leave the direction unusable, or one that removes or renames a
 * catalog-linked supporting character (`fixedCast`; unlink it in Creative setup).
 */
export function applyCastAndSetsDirectionEdits(previous, edits, { sections = [], fixedCast = [] } = {}) {
  if (!hasOwn(edits, 'renderingMedium') && !hasOwn(edits, 'sheetLayout') && edits?.sets?.length && !edits.protagonist && !edits.world && edits.sets.every((s) => Object.hasOwn(s, 'setReference') && !Object.hasOwn(s, 'imageRole'))) {
    const updates = new Map(edits.sets.map((s) => [s.id, s.setReference]));
    if ([...updates.keys()].some((id) => !previous.sets?.some((s) => s.id === id))) {
      throw new ServerError('Unknown set', { status: 422, code: 'CAST_SETS_UNKNOWN_SET' });
    }
    const sets = previous.sets.map((s) => updates.has(s.id) ? { ...s, setReference: updates.get(s.id) } : s);
    const changed = sets.filter((s) => JSON.stringify(s.setReference ?? null) !== JSON.stringify(previous.sets.find((old) => old.id === s.id).setReference ?? null)).map((s) => `${s.name} greybox reference`);
    return { direction: { ...previous, sets }, changed };
  }
  const procedural = previous?.medium === 'procedural';
  const parsed = {};
  if (hasOwn(edits, 'renderingMedium')) parsed.renderingMedium = edits.renderingMedium;
  if (hasOwn(edits, 'sheetLayout')) parsed.sheetLayout = edits.sheetLayout;
  let renamedLooks = new Map(), currentLookNames = new Set(), currentLookNamesExact = new Set();
  if (edits?.protagonist) {
    const protagonist = pickText(edits.protagonist, procedural ? CAST_SETS_EDITABLE_PROTAGONIST : CAST_SETS_EDITABLE_PHOTO_PROTAGONIST);
    if (Array.isArray(edits.protagonist.expressions)) {
      protagonist.expressions = edits.protagonist.expressions.map((x) => String(x).trim().slice(0, 300)).filter(Boolean);
    }
    if (!procedural && Array.isArray(edits.protagonist.forms)) protagonist.forms = edits.protagonist.forms;
    parsed.protagonist = protagonist;
  }
  if (procedural && edits?.world) parsed.world = pickText(edits.world, CAST_SETS_EDITABLE_WORLD);
  if (Array.isArray(edits?.looks)) {
    parsed.looks = edits.looks.map((l) => pickText(l, { name: SHORT, description: TEXT, chapters: 300 }));
    const originals = edits.looks.map((l) => l.originalName).filter(Boolean);
    const names = edits.looks.map((l) => l.name.toLowerCase());
    if (new Set(originals).size !== originals.length || originals.some((name) => !(previous.looks || []).some((look) => look.name === name)) || new Set(names).size !== names.length) {
      throw new ServerError('Look names or original references are ambiguous', { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
    }
    const renames = new Map(edits.looks.flatMap((look, i) => look.originalName ? [[look.originalName, parsed.looks[i].name]] : []));
    renamedLooks = renames;
    currentLookNames = new Set(parsed.looks.map((look) => look.name.toLowerCase()));
    currentLookNamesExact = new Set(parsed.looks.map((look) => look.name));
    parsed.tests = (previous.tests || []).map((test) => ({ ...test, look: renames.get(test.look) || test.look }));
  }
  if (!procedural && Array.isArray(edits?.props)) {
    parsed.props = edits.props.map((p) => pickText(p, { id: 64, name: SHORT, owner: SHORT, description: TEXT }));
  }
  if (!procedural && Array.isArray(edits?.cast) && edits.cast.length) {
    const fixedNames = new Set(fixedCast.map((f) => castKey(f.name)));
    const locked = edits.cast.flatMap((patch) => {
      const member = (previous.cast || []).find((c) => c.id === patch.id);
      const renamed = typeof patch.name === 'string' && castKey(patch.name) !== castKey(member?.name);
      return member && fixedNames.has(castKey(member.name)) && (patch.remove || renamed) ? [member.name] : [];
    });
    if (locked.length) {
      throw new ServerError(`${locked.join(', ')} ${locked.length > 1 ? 'are' : 'is'} cast from the catalog in Creative setup. Unlink ${locked.length > 1 ? 'them' : 'it'} there to remove or rename ${locked.length > 1 ? 'them' : 'it'}.`, { status: 422, code: 'CAST_SETS_FIXED_CAST' });
    }
    parsed.cast = patchItems(previous.cast || [], edits.cast.map((c) => ({ ...c, key: c.id })), { what: 'cast member', keyOf: (c) => c.id, fields: EDITABLE_CAST });
  }
  if (Array.isArray(edits?.sets) && edits.sets.length) {
    parsed.sets = patchItems(previous.sets || [], edits.sets.map((s) => ({ ...s, key: s.id })), {
      what: 'set', keyOf: (s) => s.id, fields: EDITABLE_SET,
      extra: (patch) => (procedural && patch.imageRole ? { imageRole: patch.imageRole } : {}),
    });
  }
  if (!procedural && Array.isArray(edits?.tests) && edits.tests.length) {
    const tests = testLookPatches(edits.tests, renamedLooks, currentLookNames, currentLookNamesExact);
    parsed.tests = patchItems(parsed.tests || previous.tests || [], tests, { what: 'test', keyOf: (_t, i) => i + 1, fields: EDITABLE_TEST, extra: testFormPatch });
    parsed.testsFixed = true;
  }
  // A director edit never drops a test silently: removing (or mistyping) the age
  // a test shows is refused until that test is reassigned or removed.
  if (!procedural) {
    const forms = normalizeForms(hasOwn(parsed.protagonist, 'forms') ? parsed.protagonist.forms : previous?.protagonist?.forms, previous?.protagonist?.forms || []);
    const orphaned = testsWithMissingForm(parsed.tests || previous?.tests, forms);
    if (orphaned.length) {
      throw new ServerError(`An age that is not on the sheet is shown by test ${orphaned.join(', ')}. Give each another age or remove it first.`, { status: 422, code: 'CAST_SETS_UNKNOWN_FORM' });
    }
  }
  const { direction, missing } = mergeCastAndSetsDirection(previous, parsed, { sections, medium: procedural ? 'procedural' : 'photographic', minSets: 1, fixedCast });
  if (missing.length) throw new ServerError(`That edit would leave the direction without: ${missing.join(', ')}`, { status: 422, code: 'CAST_SETS_EDIT_INVALID' });
  return { direction: { ...direction, look: previous.look || '' }, changed: describeEdits(previous, direction) };
}

const differs = (a, b) => JSON.stringify(a ?? '') !== JSON.stringify(b ?? '');

/** What a direct edit changed, named for the revision record. */
function describeEdits(previous, direction) {
  const p0 = previous.protagonist || {};
  const p1 = direction.protagonist || {};
  const listChanges = (label, before = [], after = [], keyOf, nameOf) => {
    const next = new Map(after.map((item, i) => [keyOf(item, i), item]));
    return before.flatMap((item, i) => {
      const now = next.get(keyOf(item, i));
      if (!now) return [`${nameOf(item, i)} removed`];
      return differs(item, now) ? [`${label} ${nameOf(now, i)}`] : [];
    });
  };
  return [
    ...((hasOwn(previous, 'renderingMedium') !== hasOwn(direction, 'renderingMedium') || differs(previous.renderingMedium, direction.renderingMedium)) ? ['rendering medium'] : []),
    ...(differs(previous.sheetLayout || 'five-view', direction.sheetLayout || 'five-view') ? ['character sheet layout'] : []),
    ...Object.keys({ ...CAST_SETS_EDITABLE_PROTAGONIST, ...CAST_SETS_EDITABLE_PHOTO_PROTAGONIST }).filter((key) => differs(p0[key], p1[key])),
    ...['expressions', 'forms'].filter((key) => differs(p0[key] || [], p1[key] || [])),
    ...Object.keys(CAST_SETS_EDITABLE_WORLD).filter((key) => differs(previous.world?.[key], direction.world?.[key])).map((key) => `world ${key}`),
    ...(differs(previous.looks || [], direction.looks || []) ? ['looks'] : []),
    ...(differs(previous.props || [], direction.props || []) ? ['props'] : []),
    ...listChanges('cast', previous.cast, direction.cast, (c) => c.id, (c) => c.name),
    ...(direction.medium === 'procedural'
      ? direction.sets.filter((set) => differs(previous.sets.find((s) => s.id === set.id)?.imageRole, set.imageRole)).map((set) => `${set.name} image role`)
      : []),
    ...listChanges('set', previous.sets, direction.sets, (s) => s.id, (s) => s.name)
      .filter((line) => direction.medium !== 'procedural' || line.endsWith(' removed') || !direction.sets.some((s) => line === `set ${s.name}` && differs(previous.sets.find((p) => p.id === s.id)?.imageRole, s.imageRole) && !differs({ ...previous.sets.find((p) => p.id === s.id), imageRole: s.imageRole }, s))),
    ...(direction.testsFixed && differs(previous.tests || [], direction.tests || []) ? ['tests'] : []),
  ];
}

// ---- text-only edits (catalog check-ins) -------------------------------------

const textList = (items, max, cap) => items.map((x) => String(x).trim().slice(0, max)).filter(Boolean).slice(0, cap);

/**
 * Apply a text-only edit to a stored direction: the look line, the
 * protagonist's signature, rules and expressions, the props and the overlay
 * concept. A catalog check-in keeps these words but renders nothing from the
 * direction, so the edit changes no image role, set or cast member and starts
 * no render. Present keys replace (an empty string or list clears); absent keys
 * keep the stored value. Returns `{ direction, changed }`.
 */
export function applyCastAndSetsDirectionTextEdits(previous, edits = {}) {
  const base = previous || {};
  const direction = { ...base };
  const changed = [];
  if (typeof edits.look === 'string') direction.look = edits.look.trim().slice(0, 500);
  if (edits.protagonist) {
    const protagonist = { ...(base.protagonist || {}) };
    if (typeof edits.protagonist.signature === 'string') protagonist.signature = edits.protagonist.signature.trim().slice(0, TEXT);
    if (Array.isArray(edits.protagonist.rules)) protagonist.rules = textList(edits.protagonist.rules, 300, CAST_SETS_LIMITS.rules);
    if (Array.isArray(edits.protagonist.expressions)) protagonist.expressions = textList(edits.protagonist.expressions, 300, CAST_SETS_LIMITS.expressions);
    direction.protagonist = protagonist;
  }
  if (Array.isArray(edits.props)) {
    direction.props = normalizeProps(edits.props.map((p) => pickText(p, { id: 64, name: SHORT, owner: SHORT, description: TEXT })));
  }
  if (edits.overlayConcept) {
    const overlay = { ...(base.overlayConcept || {}) };
    if (typeof edits.overlayConcept.summary === 'string') overlay.summary = edits.overlayConcept.summary.trim().slice(0, TEXT);
    if (Array.isArray(edits.overlayConcept.elements)) {
      overlay.elements = edits.overlayConcept.elements.map((el) => pickText(el, { name: SHORT, description: TEXT }))
        .filter((el) => el.name && el.description).slice(0, CAST_SETS_LIMITS.overlayElements);
    }
    direction.overlayConcept = overlay;
  }
  if (differs(base.look || '', direction.look || '')) changed.push('look');
  for (const key of ['signature', 'rules', 'expressions']) {
    if (differs(base.protagonist?.[key] || (key === 'signature' ? '' : []), direction.protagonist?.[key] || (key === 'signature' ? '' : []))) changed.push(key);
  }
  if (differs(base.props || [], direction.props || [])) changed.push('props');
  if (differs(base.overlayConcept || {}, direction.overlayConcept || {})) changed.push('overlay concept');
  return { direction, changed };
}

// ---- what a revision changed -------------------------------------------------

const MAX_CHANGE_LINES = 8;
const nameList = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));

/**
 * A short, plain-language list of what a revised direction changed, for the
 * director to read after feedback is applied: the look line, the protagonist,
 * the wardrobe, and per-set lighting/description. Empty when nothing the
 * images are built from changed.
 */
export function describeDirectionChanges(previous, next) {
  if (!previous || !next) return [];
  // A list a legacy direction never had reads the same as an empty one.
  const norm = (v) => (v == null || (Array.isArray(v) && !v.length) ? '' : v);
  const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  const out = [];
  if (!same(previous.look, next.look)) out.push('Scene look rewritten for set plates and in-set frames');
  const p0 = previous.protagonist || {};
  const p1 = next.protagonist || {};
  const protagonistFields = Object.keys({ ...p0, ...p1 }).filter((k) => !same(p0[k], p1[k]));
  if (protagonistFields.length) out.push(`Protagonist: ${nameList(protagonistFields)}`);
  if (!same(previous.looks, next.looks)) out.push('Wardrobe looks revised');
  if (!same(previous.cast || [], next.cast || [])) out.push('Supporting cast revised');
  if (!same(previous.props || [], next.props || [])) out.push('Props revised');
  if (!same(previous.world?.lighting, next.world?.lighting)) out.push('World lighting revised');
  const before = new Map((previous.sets || []).map((s) => [s.id, s]));
  const lit = [];
  const described = [];
  for (const set of next.sets || []) {
    const old = before.get(set.id);
    if (!old) continue;
    if (!same(old.lighting, set.lighting)) lit.push(set.name);
    if (!same(old.description, set.description)) described.push(set.name);
  }
  if (lit.length) out.push(`Lighting: ${nameList(lit)}`);
  if (described.length) out.push(`Set descriptions: ${nameList(described)}`);
  const added = (next.sets || []).filter((s) => !before.has(s.id)).map((s) => s.name);
  const removed = (previous.sets || []).filter((s) => !(next.sets || []).some((n) => n.id === s.id)).map((s) => s.name);
  if (added.length) out.push(`New sets: ${nameList(added)}`);
  if (removed.length) out.push(`Sets dropped: ${nameList(removed)}`);
  return out.slice(0, MAX_CHANGE_LINES);
}
