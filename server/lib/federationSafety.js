/**
 * "Does this JSON-shaped payload carry anything that must not leave the
 * install?" — the structured, refusal-side reading of the federation privacy
 * rule, over both the values a payload holds and the keys it names them with.
 *
 * Root `AGENTS.md` and the [machine-local privacy ADR](../../docs/decisions/2026-08-08-privacy-records-machine-local.md)
 * say PII and machine identity must not ride the federation layer at all. The
 * tree already has the scrubbers a free-text field needs — `scrubSecretTokens`
 * (credential-shaped values), `scrubHomePath` (the running user's actual home
 * prefix) — but those REWRITE text for a log or a prompt. A payload about to
 * cross to a peer needs the opposite shape: a yes/no with a JSON path, so the
 * caller can REFUSE and tell the author which field to fix. Redacting and
 * sending anyway would leave an author believing they published what they wrote.
 *
 * Hence findings rather than a scrubber, and hence a module of its own rather
 * than a private helper inside the first feature that needed it: the rule is
 * tree-wide, so the second caller should reach for this instead of copying a
 * regex list.
 *
 * Deliberately conservative about false NEGATIVES rather than false positives —
 * a four-part version string is reported as an IP literal, because the payload
 * is leaving the machine and "looks like an address" is the right side to fail
 * on when the finding names the exact path to fix.
 *
 * Pure: no I/O, no environment reads. (`scrubHomePath` is intentionally NOT
 * used here — it knows only THIS machine's home directory, while the patterns
 * below catch the shape on any machine, which is what a payload review needs.)
 */

import { scrubSecretTokens } from './secretText.js';
import { isSecretKey } from './secretKeys.js';
import { PII_PATTERNS } from './piiRedactionPatterns.js';

// The machine-identity / PII regex table itself now lives in the shared leaf
// `piiRedactionPatterns.js` (#7474), which `services/agentContextMcp.js` and
// `services/agentErrorAnalysis.js` also read — a correction here (a
// multi-label host, a Windows path, IPv6) reaches every consumer instead of
// drifting across three independently-maintained copies.

/** `a.b.0.c`, or `<root>` for a bare string handed in with no path. */
export const describeJsonPath = (path) => (path.length === 0 ? '<root>' : path.join('.'));

/**
 * Walk a JSON-shaped value once, reporting every string it contains AND every
 * object key it passes through. Keys matter as much as values: a key named for
 * a host leaks the host just as a value does.
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
 * Machine identity, network info, PII and credential findings anywhere in a
 * JSON-shaped value.
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
    // The key-name half. A value-shape scan cannot see `{ apiKey: 'hunter2' }` —
    // that secret is identifiable only by what it is CALLED, which is exactly
    // the split `secretText.js`'s own header describes.
    if (kind === 'key' && isSecretKey(text)) {
      findings.push({ code: 'secret-key', path: at, detail: 'a credential-named field may not cross the federation layer' });
    }
  });
  return findings.slice(0, limit);
}
