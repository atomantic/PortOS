/**
 * LoRA adapter-effect report rules (#4872).
 *
 * The measurement lives in Python; everything asserted here is the JS-side
 * policy that decides what a measurement MEANS — which is what a render, a
 * sidecar cache and a UI badge all depend on being identical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LORA_EFFECT_PROBE_VERSION,
  LORA_EFFECT_STATUSES,
  LORA_EFFECT_STATUS_VALUES,
  formatLoraEffect,
  isKnownLoraEffectStatus,
  loraEffectIssue,
  normalizeLoraEffectReport,
  readCachedLoraEffectReport,
} from './loraEffect.js';

const okPayload = {
  probeVersion: LORA_EFFECT_PROBE_VERSION,
  status: 'ok',
  modules: 12,
  measured: 10,
  skippedNonFinite: 2,
  skippedUnsupported: 0,
  zeroModules: 1,
  medianRms: 0.0031,
  maxRms: 0.0184,
  reason: null,
};

describe('normalizeLoraEffectReport', () => {
  it('returns null for anything that is not a payload object', () => {
    for (const raw of [null, undefined, 'ok', 42, [okPayload]]) {
      expect(normalizeLoraEffectReport(raw)).toBeNull();
    }
  });

  it('carries a well-formed payload through and stamps the cache key', () => {
    const report = normalizeLoraEffectReport(okPayload, { sizeBytes: 4096, mtimeMs: 111, measuredAt: '2026-08-23T00:00:00.000Z' });
    expect(report).toMatchObject({
      status: 'ok', modules: 12, measured: 10, skippedNonFinite: 2, zeroModules: 1,
      medianRms: 0.0031, maxRms: 0.0184,
      sizeBytes: 4096, mtimeMs: 111, measuredAt: '2026-08-23T00:00:00.000Z',
    });
  });

  it('degrades an unrecognized status to unmeasurable rather than propagating it', () => {
    // A sidecar written by a future PortOS (or hand-edited) must not smuggle a
    // status word past the verdict rules — least of all one that could be read
    // as a refusal.
    expect(normalizeLoraEffectReport({ ...okPayload, status: 'catastrophic' }).status)
      .toBe(LORA_EFFECT_STATUSES.UNMEASURABLE);
    expect(normalizeLoraEffectReport({ ...okPayload, status: undefined }).status)
      .toBe(LORA_EFFECT_STATUSES.UNMEASURABLE);
  });

  it('nulls every non-finite statistic instead of leaking NaN/Infinity to consumers', () => {
    const report = normalizeLoraEffectReport({
      ...okPayload, medianRms: NaN, maxRms: Infinity
    });
    expect(report.medianRms).toBeNull();
    expect(report.maxRms).toBeNull();
  });

  it('rejects a numeric-looking non-number statistic', () => {
    expect(normalizeLoraEffectReport({ ...okPayload, medianRms: '0.5' }).medianRms).toBeNull();
    expect(normalizeLoraEffectReport({ ...okPayload, maxRms: true }).maxRms).toBeNull();
  });

  it('drops statistics entirely when nothing was measured', () => {
    // The trap this closes: a payload claiming `measured: 0, medianRms: 0`
    // would otherwise read as "measured, and it is 0.0" — which is the exact
    // shape `zero` uses, and `zero` is the one status that refuses a render.
    const report = normalizeLoraEffectReport({ ...okPayload, measured: 0, medianRms: 0, maxRms: 0 });
    expect(report.measured).toBe(0);
    expect(report.medianRms).toBeNull();
    expect(report.maxRms).toBeNull();
  });

  it('floors negative and fractional counts to sane non-negative integers', () => {
    const report = normalizeLoraEffectReport({ ...okPayload, modules: -5, measured: 3.7, skippedNonFinite: NaN });
    expect(report.modules).toBe(0);
    expect(report.measured).toBe(3);
    expect(report.skippedNonFinite).toBe(0);
  });

  it('normalizes an empty reason to null', () => {
    expect(normalizeLoraEffectReport({ ...okPayload, reason: '' }).reason).toBeNull();
    expect(normalizeLoraEffectReport({ ...okPayload, reason: 7 }).reason).toBeNull();
  });
});

describe('isKnownLoraEffectStatus', () => {
  it('accepts exactly the five statuses and nothing else', () => {
    expect(LORA_EFFECT_STATUS_VALUES).toEqual(['ok', 'zero', 'nonfinite', 'unreadable', 'unmeasurable']);
    for (const s of LORA_EFFECT_STATUS_VALUES) expect(isKnownLoraEffectStatus(s)).toBe(true);
    for (const s of ['weak', 'OK', '', null, undefined]) expect(isKnownLoraEffectStatus(s)).toBe(false);
  });
});

describe('readCachedLoraEffectReport', () => {
  const cached = { ...okPayload, sizeBytes: 4096, mtimeMs: 1_700_000_000_000, measuredAt: '2026-08-23T00:00:00.000Z' };
  const onDisk = { sizeBytes: 4096, mtimeMs: 1_700_000_000_000 };

  it('accepts a report measured against the same file at the same probe version', () => {
    expect(readCachedLoraEffectReport(cached, onDisk)).toMatchObject({ status: 'ok', sizeBytes: 4096 });
  });

  it('drops a report whose file has changed size underneath it', () => {
    expect(readCachedLoraEffectReport(cached, { ...onDisk, sizeBytes: 8192 })).toBeNull();
  });

  it('drops a report whose file was rewritten at the SAME size', () => {
    // Size alone would keep the old verdict attached to different weights — and
    // a stale `zero` blocks renders of an adapter that may be fine.
    expect(readCachedLoraEffectReport(cached, { ...onDisk, mtimeMs: 1_700_000_009_999 })).toBeNull();
  });

  it('drops a report from a different probe version', () => {
    expect(readCachedLoraEffectReport({ ...cached, probeVersion: LORA_EFFECT_PROBE_VERSION + 1 }, onDisk)).toBeNull();
    expect(readCachedLoraEffectReport({ ...cached, probeVersion: undefined }, onDisk)).toBeNull();
  });

  it('never treats a missing stamp on either side as a match', () => {
    expect(readCachedLoraEffectReport({ ...cached, sizeBytes: undefined }, onDisk)).toBeNull();
    expect(readCachedLoraEffectReport({ ...cached, mtimeMs: undefined }, onDisk)).toBeNull();
    expect(readCachedLoraEffectReport(cached, { sizeBytes: 4096 })).toBeNull();
    expect(readCachedLoraEffectReport(cached, { mtimeMs: 1_700_000_000_000 })).toBeNull();
    expect(readCachedLoraEffectReport(cached, {})).toBeNull();
  });

  it('round-trips a report that carries the current probe version', () => {
    // The read side of the cache, exercised end-to-end: whatever a writer
    // stamps must come back out. A report stamped with the WRONG version is
    // written and then never readable, which is a silently-dead cache rather
    // than an error — see the constructor in services/loraEffectProbe.js.
    const built = normalizeLoraEffectReport({
      probeVersion: LORA_EFFECT_PROBE_VERSION, status: 'unmeasurable', reason: 'ran out of budget',
    });
    const stored = normalizeLoraEffectReport(built, { sizeBytes: 4096, mtimeMs: 111, measuredAt: 'x' });
    expect(readCachedLoraEffectReport(stored, { sizeBytes: 4096, mtimeMs: 111 }))
      .toMatchObject({ status: 'unmeasurable', reason: 'ran out of budget' });
  });

  it('keeps an unstamped sidecar payload untrusted', () => {
    // An absent version means "written by something that didn't stamp it" — a
    // legacy or hand-edited sidecar. It must NOT be inferred as current.
    const unstamped = normalizeLoraEffectReport(
      { ...okPayload, probeVersion: undefined }, { sizeBytes: 4096, mtimeMs: 111 },
    );
    expect(readCachedLoraEffectReport(unstamped, { sizeBytes: 4096, mtimeMs: 111 })).toBeNull();
  });

  it('returns null for a missing sidecar field rather than a hollow report', () => {
    expect(readCachedLoraEffectReport(undefined, onDisk)).toBeNull();
  });
});

describe('loraEffectIssue', () => {
  it('refuses a measured entirely-zero adapter, carrying the probe reason', () => {
    const report = normalizeLoraEffectReport({
      ...okPayload, status: 'zero', measured: 4, zeroModules: 4,
      skippedNonFinite: 0, skippedUnsupported: 0,
      medianRms: 0, maxRms: 0, reason: 'all 4 measurable LoRA module(s) have exactly zero effect',
    });
    expect(loraEffectIssue(report)).toMatch(/zero effect/);
  });

  it('still refuses a zero verdict that arrived without a reason', () => {
    expect(loraEffectIssue({ status: 'zero' })).toMatch(/zero effect/);
  });

  it('will not refuse on a "zero" payload that no measurement backs', () => {
    // A hand-edited sidecar (or a future probe that redefines the word) claiming
    // `zero` with nothing measured must not block a render on no evidence.
    // normalizeLoraEffectReport downgrades it before the verdict is ever asked.
    for (const bogus of [
      { ...okPayload, status: 'zero', measured: 0, zeroModules: 0 },
      { ...okPayload, status: 'zero', measured: 0, zeroModules: 4 },
      { ...okPayload, status: 'zero', measured: 6, zeroModules: 3 },
      // Skipped modules mean the adapter is not PROVABLY inert — one we could
      // not read may carry all of its effect. Mirrors the probe's own rule.
      { ...okPayload, status: 'zero', measured: 1, zeroModules: 1, skippedUnsupported: 1, skippedNonFinite: 0 },
      { ...okPayload, status: 'zero', measured: 1, zeroModules: 1, skippedUnsupported: 0, skippedNonFinite: 2 },
    ]) {
      const report = normalizeLoraEffectReport(bogus);
      expect(report.status).toBe('unmeasurable');
      expect(loraEffectIssue(report)).toBeNull();
    }
  });

  it('keeps a zero verdict that every measurement backs', () => {
    const report = normalizeLoraEffectReport({
      ...okPayload, status: 'zero', measured: 4, zeroModules: 4, medianRms: 0, maxRms: 0,
      skippedNonFinite: 0, skippedUnsupported: 0,
    });
    expect(report.status).toBe('zero');
    expect(loraEffectIssue(report)).not.toBeNull();
  });

  it('refuses NOTHING else — an unrunnable probe must never block a render', () => {
    for (const status of ['ok', 'nonfinite', 'unreadable', 'unmeasurable']) {
      expect(loraEffectIssue({ ...okPayload, status, reason: 'something alarming' })).toBeNull();
    }
    expect(loraEffectIssue(null)).toBeNull();
    expect(loraEffectIssue(undefined)).toBeNull();
  });

  it('does not invent a "too weak" refusal for a tiny but non-zero measurement', () => {
    const weak = normalizeLoraEffectReport({ ...okPayload, medianRms: 1e-12, maxRms: 1e-11, zeroModules: 0 });
    expect(loraEffectIssue(weak)).toBeNull();
  });
});

describe('formatLoraEffect', () => {
  it('summarizes a measurement with both statistics and the skip counts', () => {
    const text = formatLoraEffect(normalizeLoraEffectReport(okPayload));
    expect(text).toContain('median RMS 3.10e-3');
    expect(text).toContain('max 1.84e-2');
    expect(text).toContain('across 10 module(s)');
    expect(text).toContain('2 non-finite skipped');
    expect(text).toContain('1 zero');
  });

  it('falls back to status + reason when there is nothing measured', () => {
    const report = normalizeLoraEffectReport({
      ...okPayload, status: 'unreadable', measured: 0, reason: 'contains no lora_A/lora_B pairs',
    });
    expect(formatLoraEffect(report)).toBe('unreadable: contains no lora_A/lora_B pairs');
  });

  it('handles a null report', () => {
    expect(formatLoraEffect(null)).toBe('not measured');
  });

  it('falls back to the status line rather than crashing on a nulled statistic', () => {
    // normalizeLoraEffectReport turns a non-finite median into null while
    // leaving `measured` intact, so `measured > 0` alone is not proof there is
    // a number to format — and this runs inside a render path.
    expect(formatLoraEffect({ status: 'ok', measured: 3, medianRms: null, maxRms: 0.2, reason: null }))
      .toBe('ok');
  });
});

describe('loraEffect — JS vs the Python probe', () => {
  const probeSource = () => readFileSync(
    join(import.meta.dirname, '..', '..', 'scripts', 'lora_effect_probe.py'),
    'utf-8',
  );

  it('keeps LORA_EFFECT_PROBE_VERSION in lockstep with PROBE_VERSION', () => {
    // Drift here fails silently and expensively: every freshly written report
    // reads as stale, so the sidecar cache stops working and each render
    // re-reads the whole adapter with nothing logged anywhere.
    const match = probeSource().match(/^PROBE_VERSION = (\d+)$/m);
    expect(match, 'scripts/lora_effect_probe.py must declare PROBE_VERSION').not.toBeNull();
    expect(Number(match[1])).toBe(LORA_EFFECT_PROBE_VERSION);
  });

  it('agrees with the probe on the status vocabulary', () => {
    // The probe's own docstring names the five it may emit; a status added on
    // one side and not the other degrades to `unmeasurable` at normalization,
    // which would quietly disable the verdict rather than fail.
    const source = probeSource();
    for (const status of Object.values(LORA_EFFECT_STATUSES)) {
      expect(source, `probe never mentions status "${status}"`).toContain(status);
    }
  });
});
