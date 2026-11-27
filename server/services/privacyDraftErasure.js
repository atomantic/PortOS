/**
 * Privacy Center draft erasure: removes or redacts the plaintext email drafts Privacy Center renders from vault values when a subject, vault record, case evidence or opt-out consent goes away.
 */
import { decryptValue } from '../lib/vaultCrypto.js';
import { parseCityState } from '../lib/cityState.js';
import { PRIVACY_SENSITIVE_TYPES } from '../lib/privacyConstants.js';

// Lazy: most privacy suites never erase, and messageDrafts pulls file storage.
const drafts = () => import('./messageDrafts.js');
const metaOf = d => d.privacyMeta || {};

/** Decrypt vault ciphertexts to the plaintext needles the legacy scrub matches. */
export function decryptForScrub(encryptedValues) {
  return encryptedValues.map(decryptValue).filter(v => v.trim());
}

/** Expand decrypted vault rows into the values legacy draft text may contain. */
export function draftScrubNeedlesForRows(rows) {
  return rows.flatMap(row => {
    if (PRIVACY_SENSITIVE_TYPES.includes(row.type)) return [];
    const needles = decryptForScrub([row.value_enc]);
    if (row.type === 'address') {
      const { city, state } = parseCityState(needles[0]);
      if (city) needles.push(city);
      if (city && state) needles.push(`${city}, ${state}`);
    }
    return needles;
  });
}

export async function eraseSubjectDrafts(subjectId, legacyValues = []) {
  const { erasePrivacyDrafts, scrubLegacyPrivacyDraftValues } = await drafts();
  await erasePrivacyDrafts(d => metaOf(d).subjectId === subjectId);
  await scrubLegacyPrivacyDraftValues(legacyValues);
}

export async function revokeOptOutDrafts(subjectId) {
  const { erasePrivacyDrafts } = await drafts();
  return erasePrivacyDrafts(d => metaOf(d).subjectId === subjectId, { onlyUnsent: true, generatedBy: ['privacy-optout'] });
}

export async function eraseVaultRecordDrafts(vaultRecordId, legacyValues = []) {
  const { erasePrivacyDrafts, scrubLegacyPrivacyDraftValues } = await drafts();
  await erasePrivacyDrafts(d => (metaOf(d).vaultRecordIds || []).includes(vaultRecordId));
  await scrubLegacyPrivacyDraftValues(legacyValues);
}

export async function eraseCaseDrafts(caseId, draftId = null) {
  const { erasePrivacyDrafts } = await drafts();
  await erasePrivacyDrafts(d => metaOf(d).caseId === caseId || (draftId && d.id === draftId), { generatedBy: ['privacy-optout'] });
}
