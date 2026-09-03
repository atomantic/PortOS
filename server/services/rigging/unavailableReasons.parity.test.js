/**
 * Cross-package parity for the character-rigging readiness reason labels.
 *
 * `server/services/rigging/readiness.js` owns the reason CODES (what
 * `riggingUnavailableReason()` returns) and their labels; `client/src/lib/
 * riggingReasons.js` is a hand-maintained mirror (the client can't import the server
 * module — it reaches `node:fs`/`child_process` through the runtime probe). This suite
 * imports BOTH and asserts they stay identical, mirroring the image-to-3D lane's
 * `imageTo3d/unavailableReasons.parity.test.js`.
 *
 * It also closes the same gap that motivated the shared map there: the source guard
 * below asserts the label key set still EQUALS the codes the reducer actually returns,
 * so adding a code without a label — which would otherwise render as the generic
 * "Rigging is unavailable on this host" fallback with a fully green suite — fails here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  RIGGING_UNAVAILABLE_REASONS as SERVER_REASONS,
  RIGGING_REASON_FALLBACK as SERVER_FALLBACK,
  riggingReasonLabel as serverLabel,
} from './readiness.js';
import {
  RIGGING_UNAVAILABLE_REASONS as CLIENT_REASONS,
  RIGGING_REASON_FALLBACK as CLIENT_FALLBACK,
  riggingReasonLabel as clientLabel,
} from '../../../client/src/lib/riggingReasons.js';

// Reason codes are kebab-case (asserted below), and every OTHER single-quoted literal
// in `riggingUnavailableReason()` is a dash-free probe-status token (`'ok'`,
// `'unimportable'`) — so "quoted, has a dash" identifies the codes exactly. Comments
// are stripped first so a code named in prose can't count as a return.
const KEBAB_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function reasonCodesInSource() {
  const src = readFileSync(fileURLToPath(new URL('./readiness.js', import.meta.url)), 'utf8');
  const start = src.indexOf('export function riggingUnavailableReason(');
  expect(start, 'riggingUnavailableReason() not found in readiness.js').toBeGreaterThan(-1);
  // Bounded by the function's own column-0 closing brace, so a later declaration being
  // renamed, reordered, or inserted before the next export can't widen the window.
  const end = src.indexOf('\n}\n', start);
  expect(end, 'no column-0 closing brace found — cannot bound the reducer body').toBeGreaterThan(start);
  const body = src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]).filter((s) => KEBAB_CODE.test(s));
}

describe('rigging readiness reasons — server↔client parity', () => {
  it('exposes the same codes in the same order with the same labels', () => {
    expect(Object.entries(CLIENT_REASONS)).toEqual(Object.entries(SERVER_REASONS));
  });

  it('shares the unknown-code fallback label', () => {
    expect(CLIENT_FALLBACK).toBe(SERVER_FALLBACK);
  });

  it('labels every code identically across server and client', () => {
    const probes = [...Object.keys(SERVER_REASONS), 'not-a-real-code', '', null, undefined, '__proto__', 'constructor'];
    for (const code of probes) {
      expect(clientLabel(code), `label for ${String(code)} drifted`).toBe(serverLabel(code));
    }
  });
});

describe('rigging readiness reasons — code coverage', () => {
  // The source guard identifies codes by their kebab shape, so the shape is part of the
  // contract: a dash-free code would slip past it unlabelled.
  it('keeps every code kebab-case', () => {
    for (const code of Object.keys(SERVER_REASONS)) {
      expect(code, `${code} must be kebab-case for the source guard to see it`).toMatch(KEBAB_CODE);
    }
  });

  it('labels exactly the codes riggingUnavailableReason() can return', () => {
    const codes = reasonCodesInSource();
    expect(codes.length).toBeGreaterThan(0);
    expect([...new Set(codes)].sort()).toEqual(Object.keys(SERVER_REASONS).sort());
  });

  it('falls back for an unknown or absent code rather than rendering the raw code', () => {
    expect(serverLabel(null)).toBe(SERVER_FALLBACK);
    expect(serverLabel('brand-new-code')).toBe(SERVER_FALLBACK);
    expect(serverLabel('brand-new-code', 'custom')).toBe('custom');
    expect(serverLabel('unsupported-platform', 'custom')).toBe(SERVER_REASONS['unsupported-platform']);
  });
});
