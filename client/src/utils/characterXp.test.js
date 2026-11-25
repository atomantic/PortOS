// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { birthDateCta } from './characterXp';

describe('birthDateCta (#2757)', () => {
  it('returns null for a usable date (ok) — no CTA', () => {
    expect(birthDateCta('ok')).toBeNull();
  });

  it('prompts to SET only for a genuinely unset date', () => {
    const cta = birthDateCta('unset');
    expect(cta.kind).toBe('set');
    expect(cta.title).toBe('Set your birth date');
    expect(cta.badgeLabel).toBe('LV —');
    expect(cta.path).toBe('/meatspace/age');
  });

  it('prompts to FIX for a present-but-unusable date, distinct from set', () => {
    for (const status of ['invalid', 'future', 'unreadable']) {
      const cta = birthDateCta(status);
      expect(cta.kind).toBe('fix');
      expect(cta.title).toBe('Fix your birth date');
      expect(cta.badgeLabel).toBe('LV !');
      expect(cta.path).toBe('/meatspace/age');
    }
  });

  it('gives the unreadable case its own copy', () => {
    expect(birthDateCta('unreadable').caption).toMatch(/couldn't be read/i);
    expect(birthDateCta('future').caption).toMatch(/future/i);
    expect(birthDateCta('invalid').caption).toMatch(/invalid/i);
  });

  it('treats an unknown/absent status as unset (backward compatible)', () => {
    expect(birthDateCta(undefined).kind).toBe('set');
    expect(birthDateCta('mystery').kind).toBe('set');
  });
});
// @vitest-environment node
