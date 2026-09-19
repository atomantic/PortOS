/**
 * Coverage for the scope-adherence failure labels.
 *
 * The codes and their labels live in ONE leaf, and the client re-exports it
 * rather than copying it, so there is no parity to assert. What still needs
 * guarding is the vocabulary: a code the service can return with no label
 * renders as the generic fallback with a fully green suite.
 *
 * The leaf also declares the codes so this test never has to import the
 * service — a lib test that drags a service closure is the shape
 * `lib/importScoping.test.js` budgets against, and it cost a CI round.
 */

import { describe, it, expect } from 'vitest';
import { JEV_FAILURE_CODES } from './jev.js';
import {
  SCOPE_ADHERENCE_FAILURE_CODES,
  SCOPE_ADHERENCE_REASONS,
  SCOPE_ADHERENCE_REASON_FALLBACK,
  scopeAdherenceReasonLabel,
} from './scopeAdherenceReasons.js';

describe('scope-adherence failure labels', () => {
  it('labels every code the service adds', () => {
    expect(SCOPE_ADHERENCE_FAILURE_CODES.length).toBeGreaterThan(0);
    for (const code of SCOPE_ADHERENCE_FAILURE_CODES) {
      expect(Object.hasOwn(SCOPE_ADHERENCE_REASONS, code), `${code} has no operator-facing label`).toBe(true);
    }
  });

  it('labels every failure the scorer itself can report', () => {
    // `scoreAdherence` forwards a `jev-*` code verbatim, so a new one in
    // `lib/jev.js` would silently degrade this surface to the generic fallback.
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

  it('stays importable from the browser bundle', async () => {
    // The client re-exports this leaf. A single import added here (a settings
    // read, a path helper) would drag `node:` built-ins into the bundle, and
    // the failure would surface as a Vite build error, not a test.
    const { readFile } = await import('fs/promises');
    const source = await readFile(new URL('./scopeAdherenceReasons.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
