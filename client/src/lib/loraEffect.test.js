/**
 * The LoRA manager card's reading of an adapter-effect measurement (#4872).
 *
 * The status vocabulary is re-exported from `server/lib/loraEffect.js`, so what
 * still needs pinning is the client-only layer over it: that every verdict has a
 * badge (a new status must never render as a bare slug), that only the verdict
 * which actually refuses a render is styled as an error, and that the card's
 * detail line agrees with the server's log line wherever there are numbers to
 * print — while returning `null`, not the badge word, where there aren't.
 */
import { describe, it, expect } from 'vitest';
import {
  LORA_EFFECT_STATUSES,
  LORA_EFFECT_BADGES,
  loraEffectBadge,
  loraEffectDetail,
} from './loraEffect.js';
import {
  formatLoraEffect as serverFormat,
  loraEffectIssue,
  normalizeLoraEffectReport,
} from '../../../server/lib/loraEffect.js';

// Every report shape the card must handle: a plain measurement, one with each
// skip counter, a partially-zero adapter, and the "no numbers" cases (never
// measured, statistics nulled as non-finite, no reason at all).
const REPORTS = [
  { status: 'ok', measured: 10, medianRms: 0.0031, maxRms: 0.0184, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null },
  { status: 'ok', measured: 8, medianRms: 1e-9, maxRms: 2.5e-8, skippedNonFinite: 2, skippedUnsupported: 0, zeroModules: 0, reason: null },
  { status: 'ok', measured: 8, medianRms: 0.004, maxRms: 0.02, skippedNonFinite: 0, skippedUnsupported: 5, zeroModules: 0, reason: null },
  { status: 'ok', measured: 4, medianRms: 0.004, maxRms: 0.02, skippedNonFinite: 1, skippedUnsupported: 2, zeroModules: 3, reason: null },
  { status: 'zero', measured: 6, medianRms: 0, maxRms: 0, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 6, reason: 'all 6 measurable LoRA module(s) have exactly zero effect' },
  { status: 'unreadable', measured: 0, medianRms: null, maxRms: null, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: 'contains no lora_A/lora_B pairs' },
  { status: 'nonfinite', measured: 0, medianRms: null, maxRms: null, skippedNonFinite: 12, skippedUnsupported: 0, zeroModules: 0, reason: 'every module measured NaN' },
  { status: 'unmeasurable', measured: 0, medianRms: null, maxRms: null, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null },
  { status: 'ok', measured: 3, medianRms: null, maxRms: 0.2, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null },
];

const hasNumbers = (report) => report.measured > 0 && report.medianRms !== null && report.maxRms !== null;

describe('loraEffectBadge', () => {
  it('gives every status a badge, so a new verdict can never render as a bare slug', () => {
    expect(Object.keys(LORA_EFFECT_BADGES).sort()).toEqual(Object.values(LORA_EFFECT_STATUSES).sort());
    for (const status of Object.values(LORA_EFFECT_STATUSES)) {
      expect(loraEffectBadge(status).label).toBeTruthy();
      expect(loraEffectBadge(status).tone).toBeTruthy();
    }
  });

  it('styles exactly the refusing verdict as an error', () => {
    // The card must not invent a second blocking-looking status: whichever
    // statuses `loraEffectIssue` refuses on are the ones allowed error styling.
    const refused = Object.values(LORA_EFFECT_STATUSES)
      .filter((status) => loraEffectIssue({ status, reason: 'x' }) !== null);
    const errorStyled = Object.entries(LORA_EFFECT_BADGES)
      .filter(([, badge]) => badge.tone.includes('port-error'))
      .map(([status]) => status);
    expect(errorStyled).toEqual(refused);
    expect(refused).toEqual([LORA_EFFECT_STATUSES.ZERO]);
  });
});

describe('loraEffectDetail', () => {
  it('prints a measured report in the server’s own words', () => {
    const measured = REPORTS.map(normalizeLoraEffectReport).filter(hasNumbers);
    expect(measured.length).toBeGreaterThan(0);
    for (const report of measured) {
      expect(loraEffectDetail(report)).toBe(serverFormat(report));
      expect(loraEffectDetail(report)).toContain('median RMS');
    }
  });

  it('drops to the reason (never the badge word) where the server prints its status', () => {
    // The server's no-statistics fallback is `status[: reason]`, but the card
    // already renders the status as a badge beside this text — echoing it would
    // read "Unreadable — Unreadable". So the card contributes the reason, or
    // nothing at all, and omits the separator.
    const unmeasured = REPORTS.map(normalizeLoraEffectReport).filter((r) => !hasNumbers(r));
    expect(unmeasured.length).toBeGreaterThan(0);
    for (const report of unmeasured) {
      expect(serverFormat(report).startsWith(report.status)).toBe(true);
      expect(loraEffectDetail(report)).toBe(report.reason);
      expect(loraEffectDetail(report)).not.toBe(loraEffectBadge(report.status).label);
    }
  });

  it('has nothing to say about a null report, where the server logs "not measured"', () => {
    expect(loraEffectDetail(null)).toBeNull();
    expect(serverFormat(null)).toBe('not measured');
  });
});
