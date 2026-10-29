import { formatHeight, typicalHeightCm } from './characterHeight.js';

const isHeightStat = (s) => /^\s*height\s*$/i.test(String(s?.label || ''));

/** A character's stated height: the value of its "Height" stat, else ''. */
export const characterHeightStat = (payload) => String((Array.isArray(payload?.stats) ? payload.stats : []).find(isHeightStat)?.value || '').trim();

// A form's own height, else a child age's median, replaces the canonical Height
// stat: the present-story height on a 7-year-old's sheet draws an adult.
function formHeight(form) {
  if (form.height) return form.height;
  const cm = typicalHeightCm(form.age);
  return cm ? `about ${formatHeight(cm)}` : '';
}

// A described alternate form owns its appearance and clothing. Shared facial
// identity remains on visualIdentity; canonical outfits must not leak into it.
export function catalogAppearance(type, payload, form) {
  if (!form) return payload;
  const out = { ...payload };
  const descriptionKey = type === 'character' ? 'physicalDescription' : 'description';
  if (form.description) {
    out[descriptionKey] = form.description;
    if (type === 'character') out.wardrobes = [];
  }
  if (form.age) {
    if (type === 'character') out.age = form.age;
    else if (type === 'place') out.era = form.age;
    else out[descriptionKey] = [out[descriptionKey], form.age].filter(Boolean).join(' — ');
  }
  const height = type === 'character' ? formHeight(form) : '';
  if (height) out.stats = [...(Array.isArray(payload.stats) ? payload.stats : []).filter((s) => !isHeightStat(s)), { id: 'stat-form-height', label: 'Height', value: height }];
  return out;
}
