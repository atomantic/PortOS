import { describe, it, expect } from 'vitest';
import {
  IMAGE_VERIFICATION_DIMENSIONS,
  DEFAULT_VERIFICATION_PROFILES,
  verificationProfileSchema,
  buildMultiAspectVerificationPrompt,
  buildDefectConfirmationPrompt,
  parseVerificationResponse,
  parseConfirmationResponse,
} from './imageVerification.js';

describe('imageVerification dimensions and profiles', () => {
  it('registers the expected core dimensions', () => {
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('hands_and_fingers');
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('spurious_limbs');
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('image_composition');
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('text_generation');
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('facial_geometry');
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('physical_fusions');
    expect(IMAGE_VERIFICATION_DIMENSIONS).toHaveProperty('prompt_faithfulness');
  });

  it('validates default profiles against the schema', () => {
    for (const [key, profile] of Object.entries(DEFAULT_VERIFICATION_PROFILES)) {
      const parsed = verificationProfileSchema.safeParse(profile);
      expect(parsed.success, `Profile ${key} should validate`).toBe(true);
      expect(parsed.data.id).toBe(profile.id);
    }
  });
});

describe('buildMultiAspectVerificationPrompt', () => {
  it('includes active dimensions and original generation prompt', () => {
    const profile = DEFAULT_VERIFICATION_PROFILES.strict_anatomy;
    const prompt = buildMultiAspectVerificationPrompt({
      profile,
      prompt: 'A noir detective in rain, 1940s film',
      isImport: false,
    });

    expect(prompt).toContain('EVALUATION CRITERIA:');
    expect(prompt).toContain('Hands & Fingers');
    expect(prompt).toContain('Spurious Limbs & Anatomy');
    expect(prompt).toContain('Original Generation Prompt:');
    expect(prompt).toContain('A noir detective in rain, 1940s film');
  });

  it('handles imported images without prompt', () => {
    const profile = DEFAULT_VERIFICATION_PROFILES.quick_screen;
    const prompt = buildMultiAspectVerificationPrompt({
      profile,
      prompt: '',
      isImport: true,
    });

    expect(prompt).toContain('Imported user image');
    expect(prompt).toContain('Hands & Fingers');
  });
});

describe('buildDefectConfirmationPrompt', () => {
  it('formats skeptical confirmation request', () => {
    const prompt = buildDefectConfirmationPrompt({
      claim: '6 fingers on right hand',
      dimension: 'hands_and_fingers',
      region: 'lower-right corner',
      prompt: 'Man holding a revolver',
    });

    expect(prompt).toContain('Dimension: hands_and_fingers');
    expect(prompt).toContain('Claim: 6 fingers on right hand');
    expect(prompt).toContain('Region: lower-right corner');
    expect(prompt).toContain('Automated first looks frequently hallucinate defects');
  });
});

describe('parseVerificationResponse', () => {
  it('parses a clean passing response', () => {
    const raw = JSON.stringify({
      hands: [
        { location: 'right hand', visibleDigits: 5, anomalies: 'none', status: 'pass' },
      ],
      checks: [
        { dimension: 'hands_and_fingers', status: 'pass', severity: 'critical', note: '5 digits' },
        { dimension: 'spurious_limbs', status: 'pass', severity: 'critical', note: 'No extra limbs' },
      ],
      overallVerdict: 'pass',
      summary: 'All checks passed cleanly',
    });

    const res = parseVerificationResponse(raw);
    expect(res.overallVerdict).toBe('pass');
    expect(res.hands).toHaveLength(1);
    expect(res.hands[0].visibleDigits).toBe(5);
    expect(res.defects).toHaveLength(0);
  });

  it('detects and flags critical defect', () => {
    const raw = JSON.stringify({
      hands: [
        { location: 'left hand', visibleDigits: 6, anomalies: 'extra thumb', status: 'fail' },
      ],
      checks: [
        {
          dimension: 'hands_and_fingers',
          status: 'fail',
          severity: 'critical',
          claim: 'Extra thumb on left hand',
          region: 'center-left',
          note: 'Visible polydactyly',
        },
      ],
      overallVerdict: 'fail',
      summary: 'Hand defect detected',
    });

    const res = parseVerificationResponse(raw);
    expect(res.overallVerdict).toBe('fail');
    expect(res.defects).toHaveLength(1);
    expect(res.defects[0].dimension).toBe('hands_and_fingers');
    expect(res.defects[0].claim).toBe('Extra thumb on left hand');
  });

  it('handles fenced markdown code block output gracefully', () => {
    const text = 'Here is the evaluation:\n```json\n{\n  "overallVerdict": "pass",\n  "checks": [\n    { "dimension": "image_composition", "status": "pass", "note": "Great framing" }\n  ]\n}\n```\nHope this helps!';
    const res = parseVerificationResponse(text);
    expect(res.overallVerdict).toBe('pass');
    expect(res.checks).toHaveLength(1);
  });

  it('returns fallback on invalid JSON', () => {
    const res = parseVerificationResponse('not valid json at all');
    expect(res.overallVerdict).toBe('unreviewed');
    expect(res.defects).toEqual([]);
  });
});

describe('parseConfirmationResponse', () => {
  it('parses confirmed defect', () => {
    const raw = JSON.stringify({
      confirmed: true,
      region: 'lower-left hand',
      note: 'Undeniable sixth digit plainly visible',
    });

    const res = parseConfirmationResponse(raw);
    expect(res.confirmed).toBe(true);
    expect(res.region).toBe('lower-left hand');
    expect(res.note).toContain('sixth digit');
  });

  it('parses rejected defect (false alarm)', () => {
    const raw = JSON.stringify({
      confirmed: false,
      region: null,
      note: 'Normal hand, 5th finger was just shadowed',
    });

    const res = parseConfirmationResponse(raw);
    expect(res.confirmed).toBe(false);
  });
});
