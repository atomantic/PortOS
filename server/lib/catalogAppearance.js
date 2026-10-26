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
  return out;
}
