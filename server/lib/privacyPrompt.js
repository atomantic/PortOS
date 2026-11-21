/**
 * Recognize generated Digital Twin vault facts and replace their section in stored prompts.
 */

import { escapeRegExp } from './textUtils.js';

export const DIGITAL_TWIN_REFERENCE_LABEL = 'Digital twin reference data';
export const PRIVACY_FACTS_HEADING = '# Identity Facts (Privacy Vault)';
export const PRIVACY_FACTS_NOTICE = "Authoritative, user-verified identity facts. Treat these as the source of truth for the user's legal name, contact details, and addresses.";
const STORED_NOTICE = 'Identity facts were included in the provider request and are not stored.';
const referenceStart = `^${DIGITAL_TWIN_REFERENCE_LABEL}:\\r?\\n\`\`\`text\\r?\\n`;
const factsStart = `${escapeRegExp(PRIVACY_FACTS_HEADING)}\\r?\\n${escapeRegExp(PRIVACY_FACTS_NOTICE)}`;
const generatedSection = new RegExp(referenceStart + factsStart, 'm');
const section = new RegExp(
  `(${referenceStart})${factsStart}`
  + '(?:\\r?\\n[\\s\\S]*?)?(?=\\r?\\n\\r?\\n(?:---(?:\\r?\\n|$)|Organizations on file:|Data-broker posture:)|\\r?\\n```|$(?![\\s\\S]))',
  'gm',
);
const recordedSection = new RegExp(`${referenceStart}${escapeRegExp(STORED_NOTICE)}\\r?$`, 'm');

export function redactStoredPrivacyPrompt(prompt) {
  return prompt.replace(section, (_facts, start) => start + STORED_NOTICE);
}

export function hasStoredPrivacyFacts(prompt) {
  return recordedSection.test(prompt) || generatedSection.test(prompt);
}
