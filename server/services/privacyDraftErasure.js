/**
 * Privacy Center draft erasure: removes or redacts the plaintext email drafts Privacy Center renders from vault values when a subject, vault record, case evidence or opt-out consent goes away.
 */
import { emitToOperators } from './socketIo.js';
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

async function eraseSelectedDrafts(predicate, options, legacyValues) {
  const store = await drafts();
  const result = await store.erasePrivacyDrafts(predicate, options);
  // Invalidate open Comms views after each durable change, including when
  // the subsequent scrub of drafts without provenance fails.
  if (result.deleted || result.redacted) emitToOperators('messages:changed', {});
  if (legacyValues && await store.scrubLegacyPrivacyDraftValues(legacyValues)) emitToOperators('messages:changed', {});
  return result;
}

export function eraseSubjectDrafts(subjectId, legacyValues = []) {
  return eraseSelectedDrafts(d => metaOf(d).subjectId === subjectId, undefined, legacyValues);
}

export function revokeOptOutDrafts(subjectId) {
  return eraseSelectedDrafts(d => metaOf(d).subjectId === subjectId, { onlyUnsent: true, generatedBy: ['privacy-optout'] });
}

export function eraseVaultRecordDrafts(vaultRecordId, legacyValues = []) {
  return eraseSelectedDrafts(d => (metaOf(d).vaultRecordIds || []).includes(vaultRecordId), undefined, legacyValues);
}

export function eraseCaseDrafts(caseId, draftId = null) {
  return eraseSelectedDrafts(d => metaOf(d).caseId === caseId || (draftId && d.id === draftId), { generatedBy: ['privacy-optout'] });
}
