/**
 * Refusal-side check that a JSON-shaped payload carries no secrets, PII or machine identity before
 * leaving the install, scanning both values and keys.
 *
 * Federation must not carry PII or machine identity (root `AGENTS.md`, the
 * [machine-local privacy ADR](../../docs/decisions/2026-08-08-privacy-records-machine-local.md)).
 * Scrubbers like `scrubSecretTokens` REWRITE text; a payload about to cross to a peer needs
 * a yes/no with a JSON path so the caller can REFUSE and name the field to fix (redacting
 * and sending anyway would mislead the author). The rule is tree-wide, so reuse this
 * rather than copying a regex list.
 *
 * Conservative against false NEGATIVES: a four-part version string is reported as an IP
 * literal. Pure: no I/O or environment reads; `scrubHomePath` is NOT used because it knows
 * only THIS machine's home directory, while the patterns catch the shape on any machine.
 */

import { scrubSecretTokens } from './secretText.js';
import { isSecretKey } from './secretKeys.js';
import { PII_PATTERNS } from './piiRedactionPatterns.js';

// The regex table lives in the shared leaf `piiRedactionPatterns.js`, which other services
// also read, so a correction reaches every consumer.

/** `a.b.0.c`, or `<root>` for a bare string handed in with no path. */
export const describeJsonPath = (path) => (path.length === 0 ? '<root>' : path.join('.'));

/**
 * Walk a JSON-shaped value once, reporting every string AND every object key (a key
 * named for a host leaks it just as a value does).
 *
 * @param {unknown} value
 * @param {(entry: { text: string, path: string[], kind: 'key'|'value' }) => void} visit
 */
export function walkJsonText(value, visit, path = []) {
  if (typeof value === 'string') {
    visit({ text: value, path, kind: 'value' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkJsonText(child, visit, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    visit({ text: key, path: childPath, kind: 'key' });
    walkJsonText(child, visit, childPath);
  }
}

/**
 * Machine identity, network info, PII and credential findings anywhere in a value.
 *
 * @param {unknown} value
 * @param {{ limit?: number }} [options] - cap on findings returned
 * @returns {Array<{ code: string, path: string, detail: string }>}
 */
export function federationSafetyFindings(value, { limit = 40 } = {}) {
  const findings = [];
  walkJsonText(value, ({ text, path, kind }) => {
    const at = describeJsonPath(path);
    for (const { code, pattern } of PII_PATTERNS) {
      if (pattern.test(text)) findings.push({ code, path: at, detail: `a ${code.replace('-', ' ')} may not cross the federation layer` });
    }
    if (scrubSecretTokens(text) !== text) {
      findings.push({ code: 'secret-token', path: at, detail: 'a credential-shaped value may not cross the federation layer' });
    }
    // Key-name half: a value-shape scan cannot see `{ apiKey: 'hunter2' }`.
    if (kind === 'key' && isSecretKey(text)) {
      findings.push({ code: 'secret-key', path: at, detail: 'a credential-named field may not cross the federation layer' });
    }
  });
  return findings.slice(0, limit);
}
