import { describe, it, expect } from 'vitest';
import { MAX_JOB_TOTAL_BYTES, MAX_VALUE_BYTES, assertNoteFits, formatNotepadPromptSection, summarizeNotepad } from './autonomousJobNotepad.js';
import { noteKeySchema, putNoteBodySchema } from './autonomousJobNotepadValidation.js';

describe('autonomous job notepad limits', () => {
  it('accepts a 128-char key and rejects 129 chars or characters outside the allowed set', () => {
    expect(noteKeySchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(noteKeySchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(noteKeySchema.safeParse('last.pr:id-1_x').success).toBe(true);
    for (const bad of ['', 'has space', 'slash/key', 'ünï']) expect(noteKeySchema.safeParse(bad).success).toBe(false);
  });

  it('measures values in UTF-8 bytes, not characters', () => {
    expect(putNoteBodySchema.safeParse({ value: 'x'.repeat(MAX_VALUE_BYTES) }).success).toBe(true);
    expect(putNoteBodySchema.safeParse({ value: 'x'.repeat(MAX_VALUE_BYTES + 1) }).success).toBe(false);
    // 3 bytes per char: 5462 chars = 16386 bytes
    expect(putNoteBodySchema.safeParse({ value: '€'.repeat(5462) }).success).toBe(false);
    expect(putNoteBodySchema.safeParse({ value: 1 }).success).toBe(false);
  });

  it('charges keys plus values against the job total and lets a rewrite reuse its old size', () => {
    const full = Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, value: 'v'.repeat(MAX_VALUE_BYTES - 2) }));
    expect(summarizeNotepad(full)).toEqual({ usedBytes: MAX_JOB_TOTAL_BYTES, maxBytes: MAX_JOB_TOTAL_BYTES, remainingBytes: 0 });
    expect(() => assertNoteFits(full, 'k4', 'x')).toThrow(/exceed/);
    expect(() => assertNoteFits(full, 'k0', 'v'.repeat(MAX_VALUE_BYTES - 2))).not.toThrow();
  });
});

describe('formatNotepadPromptSection', () => {
  it('is empty for no entries so an unused notepad adds no prompt drift', () => {
    expect(formatNotepadPromptSection('job-1', [])).toBe('');
    expect(formatNotepadPromptSection('job-1', undefined)).toBe('');
  });

  it('lists entries sorted by key with a fence that survives backticks in a value', () => {
    const section = formatNotepadPromptSection('job-1', [{ key: 'b', value: 'two' }, { key: 'a', value: 'has ``` fence' }]);
    expect(section).toContain('## Job Notepad (persistent across runs)');
    expect(section).toContain('notepad set job-1 <key> <value>');
    expect(section.indexOf('### a')).toBeLessThan(section.indexOf('### b'));
    expect(section).toContain('````\nhas ``` fence\n````');
  });
});
