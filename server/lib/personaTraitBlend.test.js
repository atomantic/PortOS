import { describe, it, expect } from 'vitest';
import {
  hasTraitAdjustments,
  blendCommunicationProfile,
  describeTraitAdjustments,
  renderTraitBlendDirective,
  BIG_FIVE_LEAN
} from './personaTraitBlend.js';

describe('hasTraitAdjustments', () => {
  it('returns false for absent / empty / all-zero adjustments', () => {
    expect(hasTraitAdjustments(null)).toBe(false);
    expect(hasTraitAdjustments(undefined)).toBe(false);
    expect(hasTraitAdjustments({})).toBe(false);
    expect(hasTraitAdjustments({ formality: 0, verbosity: 0 })).toBe(false);
    expect(hasTraitAdjustments({ tone: '   ' })).toBe(false);
    expect(hasTraitAdjustments({ bigFive: { O: 0, C: 0 } })).toBe(false);
    expect(hasTraitAdjustments({ bigFive: {} })).toBe(false);
  });

  it('returns true when any field carries a real adjustment', () => {
    expect(hasTraitAdjustments({ formality: 2 })).toBe(true);
    expect(hasTraitAdjustments({ verbosity: -3 })).toBe(true);
    expect(hasTraitAdjustments({ emojiUsage: 'frequent' })).toBe(true);
    expect(hasTraitAdjustments({ tone: 'warm' })).toBe(true);
    expect(hasTraitAdjustments({ bigFive: { A: 0.3 } })).toBe(true);
  });
});

describe('blendCommunicationProfile', () => {
  it('adds the delta to the base and clamps to 1..10', () => {
    const out = blendCommunicationProfile({ formality: 5, verbosity: 8 }, { formality: 3, verbosity: 5 });
    expect(out.formality).toEqual({ base: 5, effective: 8, delta: 3 });
    // 8 + 5 = 13 clamps to 10
    expect(out.verbosity).toEqual({ base: 8, effective: 10, delta: 5 });
  });

  it('clamps a downward delta at the 1 floor', () => {
    const out = blendCommunicationProfile({ formality: 2 }, { formality: -9 });
    expect(out.formality.effective).toBe(1);
  });

  it('renders directional-only (effective null) when no base value exists', () => {
    const out = blendCommunicationProfile({}, { formality: 4 });
    expect(out.formality).toEqual({ base: null, effective: null, delta: 4 });
  });

  it('returns delta 0 / passthrough when no adjustment given for a field', () => {
    const out = blendCommunicationProfile({ formality: 6 }, {});
    expect(out.formality).toEqual({ base: 6, effective: 6, delta: 0 });
  });

  it('surfaces emoji + tone overrides with their baselines', () => {
    const out = blendCommunicationProfile(
      { emojiUsage: 'rare', preferredTone: 'measured' },
      { emojiUsage: 'frequent', tone: 'playful' }
    );
    expect(out.emojiUsage).toEqual({ base: 'rare', effective: 'frequent' });
    expect(out.tone).toEqual({ base: 'measured', effective: 'playful' });
  });

  it('tolerates non-object inputs', () => {
    const out = blendCommunicationProfile(null, null);
    expect(out.formality.effective).toBeNull();
    expect(out.emojiUsage).toBeNull();
    expect(out.tone).toBeNull();
  });
});

describe('describeTraitAdjustments', () => {
  it('returns [] when there is nothing to describe', () => {
    expect(describeTraitAdjustments({})).toEqual([]);
    expect(describeTraitAdjustments(null)).toEqual([]);
  });

  it('describes formality, verbosity direction, emoji, tone, and big-five leans', () => {
    const lines = describeTraitAdjustments({
      formality: 5,
      verbosity: -3,
      emojiUsage: 'never',
      tone: 'crisp',
      bigFive: { A: 0.5, E: -0.2 }
    });
    expect(lines).toContain('much more formal');
    expect(lines).toContain('notably more concise');
    expect(lines).toContain('emoji usage: never');
    expect(lines).toContain('tone: crisp');
    expect(lines).toContain(`much ${BIG_FIVE_LEAN.A.more}`);
    expect(lines).toContain(`notably ${BIG_FIVE_LEAN.E.less}`);
  });

  it('renders positive verbosity as elaborate', () => {
    expect(describeTraitAdjustments({ verbosity: 2 })).toContain('slightly more elaborate');
  });
});

describe('renderTraitBlendDirective', () => {
  it('returns empty string when the persona has no adjustments', () => {
    expect(renderTraitBlendDirective({ communicationProfile: { formality: 5 } }, null, 'Pro')).toBe('');
    expect(renderTraitBlendDirective({}, {}, 'Pro')).toBe('');
  });

  it('renders a calibration block with base → effective transitions', () => {
    const out = renderTraitBlendDirective(
      { communicationProfile: { formality: 4, verbosity: 7 } },
      { formality: 3, verbosity: -3 },
      'Professional'
    );
    expect(out).toContain('## Communication Calibration (Professional context)');
    expect(out).toContain('Formality: 4 → 7 (notably more formal)');
    expect(out).toContain('Verbosity: 7 → 4 (notably more concise)');
    expect(out).not.toContain('less concise');
  });

  it('renders directional intent when no base profile is recorded', () => {
    const out = renderTraitBlendDirective({}, { formality: 4 }, 'Casual');
    expect(out).toContain('Formality: notably more formal than your natural default');
  });

  it('renders emoji + tone overrides with baseline annotations', () => {
    const out = renderTraitBlendDirective(
      { communicationProfile: { emojiUsage: 'rare', preferredTone: 'measured' } },
      { emojiUsage: 'frequent', tone: 'playful' },
      'Family'
    );
    expect(out).toContain('Emoji usage: frequent (baseline rare)');
    expect(out).toContain('Tone: playful (baseline measured)');
  });

  it('renders big-five leans with base → effective when base is known', () => {
    const out = renderTraitBlendDirective(
      { bigFive: { A: 0.5 } },
      { bigFive: { A: 0.3 } },
      'Support'
    );
    expect(out).toContain('Personality lean:');
    expect(out).toContain(BIG_FIVE_LEAN.A.more);
    expect(out).toContain('(0.50 → 0.80)');
  });

  it('omits the persona name from the heading when none is given', () => {
    const out = renderTraitBlendDirective({}, { formality: 2 });
    expect(out).toContain('## Communication Calibration\n');
    expect(out).not.toContain('context)');
  });
});
