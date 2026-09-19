/**
 * Cross-package coverage for the scope-adherence failure labels.
 *
 * `server/services/scopeAdherence.js` owns the CODES; the labels live in
 * `client/src/lib/scopeAdherenceReasons.js` because nothing on the server
 * renders them. The mirror exists for the same reason `riggingReasons.js` does
 * — the client cannot import the server module — and this suite is what stops
 * a code added on one side from rendering as the generic fallback with a fully
 * green suite.
 *
 * It asserts COVERAGE, not label equality: there is no server-side label map
 * to compare against, and inventing one nothing renders would be the thing the
 * reuse rule warns about.
 */

import { describe, it, expect } from 'vitest';
import { JEV_FAILURE_CODES } from '../lib/jev.js';
import { SCOPE_ADHERENCE_FAILURE_CODES } from './scopeAdherence.js';
import {
  SCOPE_ADHERENCE_REASONS,
  SCOPE_ADHERENCE_REASON_FALLBACK,
  scopeAdherenceReasonLabel,
} from '../../client/src/lib/scopeAdherenceReasons.js';

describe('scope-adherence failure labels', () => {
  it('labels every code the service adds', () => {
    for (const code of SCOPE_ADHERENCE_FAILURE_CODES) {
      expect(Object.hasOwn(SCOPE_ADHERENCE_REASONS, code), `${code} has no operator-facing label`).toBe(true);
    }
  });

  it('labels every failure the scorer itself can report', () => {
    // `scoreAdherence` forwards a `jev-*` code verbatim, so a new one in
    // `lib/jev.js` silently degrades this surface to the generic fallback.
    for (const code of JEV_FAILURE_CODES) {
      expect(Object.hasOwn(SCOPE_ADHERENCE_REASONS, code), `${code} has no operator-facing label`).toBe(true);
    }
  });

  it('labels nothing it does not need to', () => {
    const owned = new Set([...SCOPE_ADHERENCE_FAILURE_CODES, ...JEV_FAILURE_CODES]);
    // An untrusted-content block is forwarded too, but that vocabulary is the
    // abuse guard's and is deliberately left to the shared fallback rather
    // than restated here — so anything else is a stale key from a rename.
    for (const code of Object.keys(SCOPE_ADHERENCE_REASONS)) {
      expect(owned.has(code), `${code} is labelled but no longer returned`).toBe(true);
    }
  });

  it('falls back rather than rendering a prototype member or a raw code', () => {
    expect(scopeAdherenceReasonLabel('jev-timeout')).toBe(SCOPE_ADHERENCE_REASONS['jev-timeout']);
    for (const probe of ['not-a-real-code', '', null, undefined, '__proto__', 'constructor', 'toString']) {
      expect(scopeAdherenceReasonLabel(probe), `label for ${String(probe)}`).toBe(SCOPE_ADHERENCE_REASON_FALLBACK);
    }
  });
});
