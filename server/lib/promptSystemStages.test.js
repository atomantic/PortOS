import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SYSTEM_STAGE_USAGE,
  SYSTEM_STAGE_KEYS,
  isSystemStage,
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
