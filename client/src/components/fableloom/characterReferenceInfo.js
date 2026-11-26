import { listSheetPointers } from '../../lib/sheetPointers.js';

const REQUIRED_IDENTITY_ROLES = ['neutral', 'profile', 'full-body'];

export default function characterReferenceInfo(character) {
  const imageRefs = Array.isArray(character?.imageRefs) ? character.imageRefs.filter(Boolean) : [];
  const sheetRefs = listSheetPointers(character).map(({ filename }) => filename);
  const approvedRoles = new Set(
    (Array.isArray(character?.identityPack?.assets) ? character.identityPack.assets : [])
      .filter((asset) => asset?.approved === true)
      .map((asset) => asset.role),
  );
  const missingIdentityRoles = REQUIRED_IDENTITY_ROLES.filter((role) => !approvedRoles.has(role));
  return {
    hasVisualReference: imageRefs.length > 0 || sheetRefs.length > 0 || Boolean(character?.primaryImageRef),
    sheetCount: sheetRefs.length,
    identityPackReady: missingIdentityRoles.length === 0,
    missingIdentityRoles,
  };
}
