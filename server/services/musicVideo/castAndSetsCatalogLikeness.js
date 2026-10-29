// The Casting / Environments images that condition a Cast & Sets sheet or
// plate for a subject linked to a catalog record. Without them the check-in
// only saw a visual-spec reference labeled with the subject's exact name, so
// a cast member linked from Casting rendered as a stranger.

import { characterSheetReferenceCandidates } from '../../lib/characterSheetReferences.js';
import { pickGuideMedia } from '../../lib/catalogMediaLibrary.js';
import { resolveGalleryImage, resolveImageRef } from '../../lib/pathSafety.js';
import { characterHeightStat } from '../../lib/catalogAppearance.js';
import { fixedCasting, leadingAge } from './castAndSetsDirection.js';

// The same likeness pick a Casting sheet render makes (guides, else portrait,
// canon images and references), minus images left out of likeness.
const likeness = (payload, media, want) => characterSheetReferenceCandidates(payload, media, want)
  .filter((c) => !c.leftOut).map((c) => c.filename);

const onDisk = (filename) => !!(resolveGalleryImage(filename) || resolveImageRef(filename));

// A subject linked at one age shows that age's own images when it has any;
// the canonical ones only fill in for an age with none.
function subjectImages(payload, media, formId) {
  if (!formId) return likeness(payload, media, {});
  const candidates = characterSheetReferenceCandidates(payload, media, { formId }).filter((c) => !c.leftOut);
  const own = candidates.filter((c) => c.scope === 'form');
  return (own.length ? own : candidates).map((c) => c.filename);
}

/**
 * `{ [subjectId]: { images, height?, forms: [{ age, images, height? }] } }`
 * for the project's linked cast and sets. A character's `images` and `height`
 * show the age form the subject is linked at (else the record's own, its
 * Height stat); `forms` hold each other age's own images and height. Only images whose file exists are listed, so a missing one never
 * takes a reference slot or hides the fallback. A record that fails to load
 * is skipped: its subject falls back to the project's references.
 */
export async function loadCastAndSetsCatalogLikeness(project, deps = {}) {
  const fixed = fixedCasting(project);
  if (!fixed.length) return {};
  const catalog = deps.catalog || await import('../catalogDB.js');
  const records = new Map();
  // One read per record, however many subjects (ages) link to it.
  const load = (id) => {
    if (!records.has(id)) {
      records.set(id, Promise.all([catalog.getIngredient(id), catalog.listMediaForIngredient(id)]).catch((err) => {
        console.warn(`⚠️ Cast & Sets: catalog images for ${id} unavailable: ${err.message}`);
        return [];
      }));
    }
    return records.get(id);
  };
  const exists = (filename) => (deps.exists || onDisk)(filename);
  const out = {};
  await Promise.all(fixed.map(async (f) => {
    const [record, media] = await load(f.ingredientId);
    if (!record || record.deleted || record.type !== f.kind) return;
    const rows = (Array.isArray(media) ? media : []).filter((m) => m && exists(m.mediaKey));
    if (f.kind === 'place') {
      out[f.id] = { images: pickGuideMedia(rows).map((m) => m.mediaKey), forms: [] };
      return;
    }
    const payload = record.payload || {};
    const forms = (Array.isArray(payload.forms) ? payload.forms : []).filter((form) => form?.id);
    // Canon images come from the payload, not media rows: checked here too.
    const linkedForm = f.castFormId ? forms.find((form) => form.id === f.castFormId) : null;
    // A linked age states only its own height: the canonical one is another age's.
    const height = String(linkedForm ? linkedForm.height || '' : characterHeightStat(payload)).trim();
    out[f.id] = {
      images: subjectImages(payload, rows, f.castFormId).filter(exists),
      ...(height ? { height } : {}),
      // Only an age's own images: the canonical ones show another age.
      forms: forms.map((form) => ({
        age: leadingAge(form.age),
        images: characterSheetReferenceCandidates(payload, rows, { formId: form.id })
          .filter((c) => !c.leftOut && c.scope === 'form' && exists(c.filename)).map((c) => c.filename),
        ...(form.height ? { height: String(form.height).trim() } : {}),
      })).filter((form) => form.age !== null && (form.images.length || form.height)),
    };
  }));
  return out;
}
