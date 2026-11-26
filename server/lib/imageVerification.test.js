import { describe, it, expect } from 'vitest';
import {
  IMAGE_VERIFICATION_DIMENSIONS,
  DEFAULT_VERIFICATION_PROFILES,
  verificationProfileSchema,
  buildMultiAspectVerificationPrompt,
  buildBatchDefectConfirmationPrompt,
  MAX_CONFIRMATION_DEFECTS,
  parseVerificationResponse,
  parseBatchConfirmationResponse,
  VERIFIER_REVIEWER_MODELS,
  normalizeReviewerModel,
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

describe('buildBatchDefectConfirmationPrompt', () => {
  it('assigns stable indices and caps the requested claims', () => {
    const defects = Array.from({ length: MAX_CONFIRMATION_DEFECTS + 2 }, (_, index) => ({
      claim: `Claim ${index}`,
      dimension: 'hands_and_fingers',
      region: 'lower-right corner',
    }));
    const prompt = buildBatchDefectConfirmationPrompt({ defects, prompt: 'A person waving' });

    const claims = JSON.parse(prompt.split('\n').find((line) => line.startsWith('Claims: ')).slice('Claims: '.length));
    expect(claims).toEqual(defects.slice(0, MAX_CONFIRMATION_DEFECTS).map((defect, index) => ({ ...defect, index })));
    expect(prompt).toContain('A person waving');
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

describe('parseBatchConfirmationResponse', () => {
  it('parses out-of-order confirmations and rejections from fenced JSON', () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 2, confirmed: false, region: null, note: ' Normal occlusion ' },
        { index: 0, confirmed: true, region: ' lower-left hand ', note: 'Sixth digit visible' },
      ],
    });
    expect(parseBatchConfirmationResponse(`Here is the assessment:\n\`\`\`json\n${raw}\n\`\`\``, 3)).toEqual({
      verdicts: [
        { index: 2, confirmed: false, region: null, note: 'Normal occlusion' },
        { index: 0, confirmed: true, region: 'lower-left hand', note: 'Sixth digit visible' },
      ],
    });
  });

  it('discards duplicate, malformed and out-of-range entries independently', () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 0, confirmed: true },
        { index: 0, confirmed: false },
        { index: 1, confirmed: 'true' },
        { index: -1, confirmed: true },
        { index: '2', confirmed: true },
        { index: MAX_CONFIRMATION_DEFECTS, confirmed: true },
        null,
        { index: 3, confirmed: true, region: 20, note: [] },
      ],
    });
    expect(parseBatchConfirmationResponse(raw, MAX_CONFIRMATION_DEFECTS + 1)).toEqual({
      verdicts: [{ index: 3, confirmed: true, region: null, note: '' }],
    });
  });

  it('returns no verdicts if the response is missing or invalid', () => {
    expect(parseBatchConfirmationResponse('not JSON', 2)).toEqual({ verdicts: [] });
    expect(parseBatchConfirmationResponse('{"verdicts":{}}', 2)).toEqual({ verdicts: [] });
  });
});

describe('VERIFIER_REVIEWER_MODELS and normalizeReviewerModel', () => {
  it('registers Argon and Qwen models', () => {
    const ids = VERIFIER_REVIEWER_MODELS.map((m) => m.id);
    expect(ids).toContain('gemini-4-argon');
    expect(ids).toContain('qwen-27b');
  });

  it('normalizes model aliases', () => {
    expect(normalizeReviewerModel('argon')).toBe('gemini-4-argon');
    expect(normalizeReviewerModel('gemini-4-argon-high')).toBe('gemini-4-argon');
    expect(normalizeReviewerModel('qwen-27g')).toBe('qwen-27b');
    expect(normalizeReviewerModel('qwen3.8:27b')).toBe('qwen-27b');
    expect(normalizeReviewerModel('auto')).toBeNull();
  });
});
