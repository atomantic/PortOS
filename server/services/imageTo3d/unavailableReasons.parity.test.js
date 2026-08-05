/**
 * Cross-package parity for the image-to-3D unavailable-reason labels.
 *
 * `server/services/imageTo3d/targets.js` owns the reason CODES (what
 * `unavailableReason()` returns) and their labels; `client/src/lib/
 * imageTo3dReasons.js` is a hand-maintained mirror (the client can't import the
 * registry — it reaches `os`/`child_process` through the capability probes).
 * This suite imports BOTH and asserts they stay identical, mirroring
 * `server/lib/catalogTypes.parity.test.js`.
 *
 * It also closes the gap that motivated the shared map (#3579): the source
 * guard below asserts the label key set still EQUALS the codes the function
 * actually returns, so adding a code without a label — which used to render as
 * the generic "Unsupported on this host" fallback with a fully green suite —
 * fails here instead.
 *
 * It lives server-side because the server registry can't load under the client
 * (jsdom) runner, but the pure client mirror loads fine here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  UNAVAILABLE_REASONS as SERVER_REASONS,
  UNAVAILABLE_REASON_FALLBACK as SERVER_FALLBACK,
  unavailableReasonLabel as serverLabel,
  UNFIXABLE_HARDWARE_REASONS,
} from './targets.js';
import {
  UNAVAILABLE_REASONS as CLIENT_REASONS,
  UNAVAILABLE_REASON_FALLBACK as CLIENT_FALLBACK,
  unavailableReasonLabel as clientLabel,
} from '../../../client/src/lib/imageTo3dReasons.js';

// Reason codes are kebab-case (asserted below), and every OTHER single-quoted
// literal in `unavailableReason()` is a dash-free status token (`'unknown'`, the
// cudaProbe state) — so "quoted, has a dash" identifies the codes exactly.
// Comments are stripped first so a code named in prose can't count as a return.
const KEBAB_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function reasonCodesInSource() {
  const src = readFileSync(fileURLToPath(new URL('./targets.js', import.meta.url)), 'utf8');
  const start = src.indexOf('export function unavailableReason(');
  expect(start, 'unavailableReason() not found in targets.js').toBeGreaterThan(-1);
  // End at whatever export follows — robust to the next declaration being
  // renamed, reordered, or having a new export inserted before it.
  const after = src.indexOf('\nexport ', start + 1);
  expect(after, 'no export follows unavailableReason() — cannot bound its body').toBeGreaterThan(start);
  const body = src.slice(start, after)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]).filter((s) => KEBAB_CODE.test(s));
}

describe('image-to-3D unavailable reasons — server↔client parity', () => {
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

describe('image-to-3D unavailable reasons — code coverage', () => {
  // The source guard below identifies codes by their kebab shape, so the shape
  // is part of the contract: a dash-free code would slip past it unlabelled.
  it('keeps every code kebab-case', () => {
    for (const code of Object.keys(SERVER_REASONS)) {
      expect(code, `${code} must be kebab-case for the source guard to see it`).toMatch(KEBAB_CODE);
    }
  });

  it('labels exactly the codes unavailableReason() can return', () => {
    const codes = reasonCodesInSource();
    expect(codes.length).toBeGreaterThan(0);
    expect([...new Set(codes)].sort()).toEqual(Object.keys(SERVER_REASONS).sort());
  });

  it('labels every unfixable-hardware reason', () => {
    for (const code of UNFIXABLE_HARDWARE_REASONS) {
      expect(SERVER_REASONS[code], `${code} has no label`).toBeTruthy();
    }
  });

  it('falls back for an unknown or absent code rather than rendering the raw code', () => {
    expect(serverLabel(null)).toBe(SERVER_FALLBACK);
    expect(serverLabel('brand-new-code')).toBe(SERVER_FALLBACK);
    expect(serverLabel('brand-new-code', 'custom')).toBe('custom');
    expect(serverLabel('requires-cuda', 'custom')).toBe(SERVER_REASONS['requires-cuda']);
  });
});
