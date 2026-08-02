import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTECTED_STAGE_KEYS,
  STAGE_CALL_SITES,
  SYSTEM_STAGE_USAGE,
  SYSTEM_STAGE_KEYS,
  isProtectedStage,
  isSystemStage,
  stageReferencedBy,
  systemStageUsedBy,
} from './promptSystemStages.js';

describe('promptSystemStages', () => {
  it('derives the key list from the usage map rather than restating it', () => {
    expect(SYSTEM_STAGE_KEYS).toEqual(Object.keys(SYSTEM_STAGE_USAGE));
  });

  it('recognizes every system stage', () => {
    for (const key of SYSTEM_STAGE_KEYS) expect(isSystemStage(key)).toBe(true);
  });

  it('is false for user-authored stages and non-keys', () => {
    expect(isSystemStage('pipeline-prose-draft')).toBe(false);
    expect(isSystemStage(undefined)).toBe(false);
    expect(isSystemStage('')).toBe(false);
    // Prototype keys must not read as system stages.
    expect(isSystemStage('toString')).toBe(false);
    expect(isSystemStage('constructor')).toBe(false);
  });

  it('describes each system stage with at least one non-empty usage string', () => {
    for (const key of SYSTEM_STAGE_KEYS) {
      const usedBy = systemStageUsedBy(key);
      expect(usedBy.length).toBeGreaterThan(0);
      for (const entry of usedBy) expect(entry.trim()).not.toBe('');
    }
  });

  it('returns an empty usage array for an unknown stage', () => {
    expect(systemStageUsedBy('pipeline-prose-draft')).toEqual([]);
    expect(systemStageUsedBy(undefined)).toEqual([]);
    // Inherited Object.prototype members must not leak through as usage.
    expect(systemStageUsedBy('toString')).toEqual([]);
    expect(systemStageUsedBy('constructor')).toEqual([]);
  });
});

// Drift guard for the failure this module exists to end (#3314): a system-stage
// key with no shipped stage-config entry never renders a row in the Prompt
// Manager, so the SYSTEM badge and the System-only filter silently reference a
// stage the user cannot see or configure. `cos-task-enhance` sat in that state
// until it was given a real entry.
describe('shipped stage catalog parity', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const shipped = JSON.parse(
    readFileSync(resolve(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'),
  ).stages;

  it('ships a stage-config entry for every system stage', () => {
    const missing = SYSTEM_STAGE_KEYS.filter((key) => !shipped[key]);
    expect(missing).toEqual([]);
  });
});

// #3335 split deletion protection from the SYSTEM badge. The two sets must
// stay distinguishable: widening protection is safe, widening the badge is a
// product regression (it would badge ~100 of 127 rows and make the
// "System only" filter useless).
describe('derived call-site protection', () => {
  const REFERENCED_NOT_CURATED = 'pipeline-series-concept-judge';

  it('keeps the curated badge set to the ten hand-picked stages', () => {
    expect(SYSTEM_STAGE_KEYS).toHaveLength(10);
    expect(isSystemStage(REFERENCED_NOT_CURATED)).toBe(false);
    expect(systemStageUsedBy(REFERENCED_NOT_CURATED)).toEqual([]);
  });

  it('protects a referenced stage the curated set never mentions', () => {
    expect(stageReferencedBy(REFERENCED_NOT_CURATED).length).toBeGreaterThan(0);
    expect(isProtectedStage(REFERENCED_NOT_CURATED)).toBe(true);
  });

  it('protects every curated stage even when no source references it by name', () => {
    // Four curated keys (`cos-evaluate`, `app-detection`, …) have no literal
    // call site in `server/` today; the union is what keeps them guarded.
    for (const key of SYSTEM_STAGE_KEYS) expect(isProtectedStage(key)).toBe(true);
  });

  it('leaves user-authored stages deletable', () => {
    expect(isProtectedStage('my-own-stage')).toBe(false);
    expect(stageReferencedBy('my-own-stage')).toEqual([]);
    expect(isProtectedStage(undefined)).toBe(false);
    expect(isProtectedStage('')).toBe(false);
    // Prototype keys must not resolve through Object.prototype here either.
    expect(isProtectedStage('toString')).toBe(false);
    expect(stageReferencedBy('constructor')).toEqual([]);
  });

  it('unions the curated and derived sets into PROTECTED_STAGE_KEYS', () => {
    const expected = [...new Set([...SYSTEM_STAGE_KEYS, ...Object.keys(STAGE_CALL_SITES)])].sort();
    expect(PROTECTED_STAGE_KEYS).toEqual(expected);
    expect(PROTECTED_STAGE_KEYS.length).toBeGreaterThan(SYSTEM_STAGE_KEYS.length);
    for (const key of PROTECTED_STAGE_KEYS) expect(isProtectedStage(key)).toBe(true);
  });

  it('reports call sites as repo-relative server paths', () => {
    for (const path of stageReferencedBy(REFERENCED_NOT_CURATED)) {
      expect(path).toMatch(/^server\//);
    }
  });
});
