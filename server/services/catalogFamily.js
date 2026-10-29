/**
 * Family ties between cast records, as render context.
 *
 * A character's outbound family relations ("this record is the mother of
 * Nora") feed its renders: each relative's description becomes a labeled
 * prompt addition, and each relative's top canonical image becomes an extra
 * reference after the record's own. Blood relatives lend inherited
 * resemblance; a spouse or partner lends era and age fit only. Inbound edges
 * belong to the other record's renders, so they are not used here.
 */

import { getRelationKind, isFamilyRelationKind } from '../lib/catalogTypes.js';
import { characterSheetReferenceCandidates } from '../lib/characterSheetReferences.js';
import { promptAddition } from '../lib/modelInput.js';

// More relatives than this add little likeness and crowd out the record's own
// references and the prompt.
export const FAMILY_CONTEXT_MAX = 6;

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

function relativeDescription(payload) {
  const age = trim(payload.age);
  return [
    age ? `age ${age}` : '',
    trim(payload.physicalDescription),
    trim(payload.visualIdentity),
  ].filter(Boolean).join('; ');
}

function relativeText(selfName, kind, otherName, description) {
  const opening = `${selfName} is the ${kind.term} of ${otherName}.${description ? ` ${otherName}: ${description}.` : ''}`;
  return kind.blood
    ? `${opening} Give ${selfName} a believable family resemblance to ${otherName} (shared facial structure, eyes, nose and coloring) at ${selfName}’s own age.`
    : `${opening} Make ${selfName} look like a believable ${kind.term} for ${otherName}: the same era and world and a fitting age, without copying ${otherName}’s face.`;
}

/** The instruction that explains attached relatives' images, or null when none are sent. */
export function familyImagesAddition(selfName, relatives) {
  if (!relatives.length) return null;
  const list = relatives.map((r) => `${r.name} (${r.blood ? 'blood relative' : 'by marriage'})`).join(', ');
  const text = `The attached images of ${list} show ${selfName}’s family, not ${selfName}. Take inherited features only from blood relatives; use family by marriage only for era, age and styling.`;
  return promptAddition('family-images', 'Family reference images', text);
}

/**
 * `{ additions, candidates }` for one record: a labeled addition per relative
 * and that relative's top canonical image as a reference candidate tagged
 * `relative` (blood relatives first). Empty for a record with no family.
 */
export async function catalogFamilyRenderContext(ingredientId, selfName) {
  if (!ingredientId) return { additions: [], candidates: [] };
  // Lazy like the universe sheet renderer's own catalog read: that module is
  // loaded by universe-only paths that never touch the catalog.
  const { getIngredient, listMediaForIngredient, listRelationsForIngredient } = await import('./catalogDB.js');
  const { outbound } = await listRelationsForIngredient(ingredientId);
  const edges = outbound
    .filter((edge) => isFamilyRelationKind(edge.kind) && edge.other?.type === 'character')
    .slice(0, FAMILY_CONTEXT_MAX);
  const name = trim(selfName) || 'This character';
  const relatives = await Promise.all(edges.map(async (edge) => {
    const [record, media] = await Promise.all([getIngredient(edge.other.id), listMediaForIngredient(edge.other.id)]);
    if (!record || record.deleted) return null;
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const kind = getRelationKind(edge.kind);
    const top = characterSheetReferenceCandidates(payload, media).find((c) => !c.leftOut);
    return { edge, record, kind, payload, top };
  }));
  const live = relatives.filter(Boolean);
  const additions = live.map(({ edge, record, kind, payload }) => promptAddition(
    `family-${edge.kind}-${record.id}`,
    `Family · ${kind.label} ${record.name}`,
    relativeText(name, kind, record.name, relativeDescription(payload)),
  )).filter(Boolean);
  const candidates = [...live.filter((r) => r.kind.blood), ...live.filter((r) => !r.kind.blood)]
    .filter((r) => r.top)
    .map(({ record, kind, top }) => ({
      filename: top.filename,
      source: `${kind.label} ${record.name} · ${top.source}`,
      relative: { name: record.name, term: kind.term, blood: kind.blood },
    }));
  return { additions, candidates };
}
