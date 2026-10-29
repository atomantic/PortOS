// The Casting / Environments images that condition a Cast & Sets sheet or
// plate for a subject linked to a catalog record. Without them the check-in
// only saw a visual-spec reference labeled with the subject's exact name, so
// a cast member linked from Casting rendered as a stranger.

import { characterSheetReferenceCandidates } from '../../lib/characterSheetReferences.js';
import { pickGuideMedia } from '../../lib/catalogMediaLibrary.js';
import { fixedCasting, leadingAge } from './castAndSetsDirection.js';

// The same likeness pick a Casting sheet render makes (guides, else portrait,
// canon images and references), minus images left out of likeness.
const likeness = (payload, media, want) => characterSheetReferenceCandidates(payload, media, want)
  .filter((c) => !c.leftOut).map((c) => c.filename);

/**
 * `{ [ingredientId]: { images, forms: [{ age, images }] } }` for the project's
 * linked cast and sets. A character's `images` show the age form the subject
 * is linked at (else the record's own); `forms` hold each other age's own
 * images. A record that fails to load is skipped: its subject falls back to
 * the project's references.
 */
export async function loadCastAndSetsCatalogLikeness(project, deps = {}) {
  const ids = new Map();
  for (const f of fixedCasting(project)) if (!ids.has(f.ingredientId)) ids.set(f.ingredientId, f);
  if (!ids.size) return {};
  const catalog = deps.catalog || await import('../catalogDB.js');
  const out = {};
  await Promise.all([...ids.values()].map(async (f) => {
    const loaded = await Promise.all([catalog.getIngredient(f.ingredientId), catalog.listMediaForIngredient(f.ingredientId)])
      .catch((err) => {
        console.warn(`⚠️ Cast & Sets: catalog images for ${f.ingredientId} unavailable: ${err.message}`);
        return null;
      });
    const [record, media] = loaded || [];
    if (!record || record.deleted || record.type !== f.kind) return;
    const rows = Array.isArray(media) ? media : [];
    if (f.kind === 'place') {
      out[f.ingredientId] = { images: pickGuideMedia(rows).map((m) => m.mediaKey), forms: [] };
      return;
    }
    const payload = record.payload || {};
    const forms = (Array.isArray(payload.forms) ? payload.forms : []).filter((form) => form?.id);
    out[f.ingredientId] = {
      images: likeness(payload, rows, f.castFormId ? { formId: f.castFormId } : {}),
      // Only an age's own images: the canonical ones show another age.
      forms: forms.map((form) => ({
        age: leadingAge(form.age),
        images: characterSheetReferenceCandidates(payload, rows, { formId: form.id })
          .filter((c) => !c.leftOut && c.scope === 'form').map((c) => c.filename),
      })).filter((form) => form.age !== null && form.images.length),
    };
  }));
  return out;
}
