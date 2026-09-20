import { describe, it, expect } from 'vitest';
import {
  VIDEO_MODEL_DISCLOSURES,
  VIDEO_BACKEND_DISCLOSURES,
  VIDEO_DISCLOSURE_REVIEWED_AT,
  applyVideoDisclosures,
  isVideoModelTermsAccepted,
  acceptedVideoModelTerms,
  videoModelTermsGateId,
  videoModelTermsError,
  videoBackendDisclosure,
} from './videoDisclosure.js';

const CANONICAL_FIELDS = ['repo', 'revision', 'runtime', 'memoryGb', 'supportedModes', 'requiredWeights', 'repoFiles'];
const RANKING_WORDS = /uncensored|unrestricted|\bunsafe\b|\bsafe\b|less restrictive|no limits/i;

describe('VIDEO_MODEL_DISCLOSURES', () => {
  it('carries the verification date for new entries and preserves previous review dates', () => {
    for (const [id, spec] of Object.entries(VIDEO_MODEL_DISCLOSURES)) {
      const newlyReviewed = ['fasth3_v2_int8', 'fasth3_v2_int6', 'minimax_h3_4bit', 'minimax_h3_6bit'].includes(id);
      expect(spec.disclosure.reviewedAt, id).toBe(newlyReviewed ? '2026-09-19' : VIDEO_DISCLOSURE_REVIEWED_AT);
    }
    expect(VIDEO_DISCLOSURE_REVIEWED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never duplicates a canonical registry field inside disclosure', () => {
    for (const [id, spec] of Object.entries(VIDEO_MODEL_DISCLOSURES)) {
      for (const field of CANONICAL_FIELDS) {
        expect(Object.keys(spec.disclosure), `${id}.${field}`).not.toContain(field);
      }
    }
  });

  it('uses https URLs for every link it publishes', () => {
    for (const [id, spec] of Object.entries(VIDEO_MODEL_DISCLOSURES)) {
      const { modelCardUrl, weightsLicense, runtimeLicense } = spec.disclosure;
      for (const url of [modelCardUrl, weightsLicense?.url, runtimeLicense?.url]) {
        if (url === undefined) continue;
        expect(url, id).toMatch(/^https:\/\//);
      }
    }
  });

  it('gives every license descriptor both a name and a url', () => {
    for (const [id, spec] of Object.entries(VIDEO_MODEL_DISCLOSURES)) {
      for (const key of ['weightsLicense', 'runtimeLicense']) {
        const license = spec.disclosure[key];
        if (!license) continue;
        expect(typeof license.name, `${id}.${key}.name`).toBe('string');
        expect(license.name.length, `${id}.${key}.name`).toBeGreaterThan(0);
        expect(license.url, `${id}.${key}.url`).toMatch(/^https:\/\//);
      }
    }
  });

  it('omits facts that are not established rather than guessing them', () => {
    // The notapalindrome LTX-2.3 cards declare no license — no weights license
    // may be inferred from the repo name or from a sibling model.
    expect('weightsLicense' in VIDEO_MODEL_DISCLOSURES.ltx23_unified.disclosure).toBe(false);
    expect('weightsLicense' in VIDEO_MODEL_DISCLOSURES.ltx23_distilled_q4.disclosure).toBe(false);
    // The Windows entry has no repo, so no model card and no weights license.
    const windowsEntry = VIDEO_MODEL_DISCLOSURES.ltx_video.disclosure;
    expect('modelCardUrl' in windowsEntry).toBe(false);
    expect('weightsLicense' in windowsEntry).toBe(false);
    expect('estimatedDownloadGb' in windowsEntry).toBe(false);
  });

  it('positive download estimates only', () => {
    for (const [id, spec] of Object.entries(VIDEO_MODEL_DISCLOSURES)) {
      const gb = spec.disclosure.estimatedDownloadGb;
      if (gb === undefined) continue;
      expect(typeof gb, id).toBe('number');
      expect(gb, id).toBeGreaterThan(0);
    }
  });

  it('is frozen so a consumer cannot mutate the shared license descriptors', () => {
    const before = VIDEO_MODEL_DISCLOSURES.wan22_ti2v_5b.disclosure.weightsLicense.name;
    expect(() => { VIDEO_MODEL_DISCLOSURES.wan22_ti2v_5b.disclosure.weightsLicense.name = 'hacked'; }).toThrow();
    expect(VIDEO_MODEL_DISCLOSURES.wan22_ti2v_5b.disclosure.weightsLicense.name).toBe(before);
  });

  it('publishes the exact MiniMax H3 territory gate and pinned license', () => {
    const h3 = VIDEO_MODEL_DISCLOSURES.minimax_h3_8bit;
    expect(h3.disclosure.estimatedDownloadGb).toBe(103.3);
    expect(h3.termsGate.id).toBe('minimax-h3-community-license-2026-08-02');
    expect(h3.termsGate.excludedTerritories).toEqual([
      'European Union',
      'United Kingdom',
      'Republic of Korea',
      'United States of America',
    ]);
    expect(h3.termsGate.licenseUrl).toContain('/blob/6818f6c32d12b210915e44ad56a4228c2608f160/LICENSE');
  });
});

describe('applyVideoDisclosures', () => {
  const shipped = (over = {}) => ({
    id: 'wan22_ti2v_5b',
    repo: VIDEO_MODEL_DISCLOSURES.wan22_ti2v_5b.shippedRepo,
    runtime: 'wan22',
    ...over,
  });

  it('attaches the shipped disclosure to a matching entry', () => {
    const [entry] = applyVideoDisclosures([shipped()]);
    expect(entry.disclosure).toEqual(VIDEO_MODEL_DISCLOSURES.wan22_ti2v_5b.disclosure);
  });

  it('does not mutate the input entry', () => {
    const input = shipped();
    applyVideoDisclosures([input]);
    expect('disclosure' in input).toBe(false);
  });

  it('preserves an existing disclosure value, including an intentional clear', () => {
    expect(applyVideoDisclosures([shipped({ disclosure: null })])[0].disclosure).toBe(null);
    const custom = { modelCardUrl: 'https://example.com/card' };
    expect(applyVideoDisclosures([shipped({ disclosure: custom })])[0].disclosure).toBe(custom);
  });

  it('skips a fork — upstream facts are not attributed to a re-pointed repo', () => {
    const [entry] = applyVideoDisclosures([shipped({ repo: 'example-org/wan-fork' })]);
    expect('disclosure' in entry).toBe(false);
  });

  it('skips custom / unknown ids', () => {
    const [entry] = applyVideoDisclosures([{ id: 'my_model', repo: 'example-org/mine', source: 'user' }]);
    expect('disclosure' in entry).toBe(false);
  });

  it('attaches to the repo-less windows entry (shippedRepo null)', () => {
    const [entry] = applyVideoDisclosures([{ id: 'ltx_video', runtime: 'mlx_video' }]);
    expect(entry.disclosure).toEqual(VIDEO_MODEL_DISCLOSURES.ltx_video.disclosure);
  });

  it('tolerates malformed rows and non-array input', () => {
    expect(applyVideoDisclosures(null)).toBe(null);
    expect(applyVideoDisclosures([null, 42, { name: 'no id' }])).toEqual([null, 42, { name: 'no id' }]);
  });

  it('reattaches the shipped H3 execution gate even if an old registry omitted it', () => {
    const [entry] = applyVideoDisclosures([{
      id: 'minimax_h3_8bit',
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      runtime: 'minimax_h3',
    }]);
    expect(entry.termsGate).toBe(VIDEO_MODEL_DISCLOSURES.minimax_h3_8bit.termsGate);
  });
});

describe('isVideoModelTermsAccepted', () => {
  const restricted = { termsGate: VIDEO_MODEL_DISCLOSURES.minimax_h3_8bit.termsGate };

  it('requires the exact versioned id in the install acknowledgement list', () => {
    const id = restricted.termsGate.id;
    expect(isVideoModelTermsAccepted(restricted, [id])).toBe(true);
    expect(isVideoModelTermsAccepted(restricted, ['another-license'])).toBe(false);
    expect(isVideoModelTermsAccepted(restricted, [])).toBe(false);
    expect(isVideoModelTermsAccepted(restricted)).toBe(false);
    // A truthy non-array (a sloppy caller's "accepted" boolean) must never
    // stand in for the exact id.
    expect(isVideoModelTermsAccepted(restricted, true)).toBe(false);
  });

  it('does not gate an unrestricted or malformed model entry', () => {
    expect(isVideoModelTermsAccepted({})).toBe(true);
    expect(isVideoModelTermsAccepted(null)).toBe(true);
  });
});

describe('videoModelTermsError', () => {
  it('names the model and where the acknowledgement is made', () => {
    const err = videoModelTermsError({ name: 'Example Model' }, 'download');
    expect(err.status).toBe(403);
    expect(err.code).toBe('VIDEO_MODEL_TERMS_ACCEPTANCE_REQUIRED');
    expect(err.message).toContain('Example Model');
    expect(err.message).toContain('before download');
    // A producer with no UI reports this message verbatim on a failed job, so
    // it has to say where the acceptance lives.
    expect(err.message).toMatch(/Video Gen page/);
  });
});

describe('acceptedVideoModelTerms', () => {
  it('reads the persisted list, dropping non-string and duplicate entries', () => {
    expect(acceptedVideoModelTerms({ videoGen: { acceptedModelTerms: ['a', 'a', '', 3, null, 'b'] } }))
      .toEqual(['a', 'b']);
  });

  it('treats a missing, malformed, or absent settings shape as no acknowledgement', () => {
    expect(acceptedVideoModelTerms(undefined)).toEqual([]);
    expect(acceptedVideoModelTerms({})).toEqual([]);
    expect(acceptedVideoModelTerms({ videoGen: {} })).toEqual([]);
    expect(acceptedVideoModelTerms({ videoGen: { acceptedModelTerms: 'a' } })).toEqual([]);
  });
});

describe('videoModelTermsGateId', () => {
  it('returns the exact id for a gated model and null for everything else', () => {
    const gate = VIDEO_MODEL_DISCLOSURES.minimax_h3_8bit.termsGate;
    expect(videoModelTermsGateId({ termsGate: gate })).toBe(gate.id);
    expect(videoModelTermsGateId({ termsGate: { id: '' } })).toBe(null);
    expect(videoModelTermsGateId({})).toBe(null);
    expect(videoModelTermsGateId(null)).toBe(null);
  });
});

describe('VIDEO_BACKEND_DISCLOSURES', () => {
  it('covers the local and grok backends with an execution discriminator', () => {
    expect(VIDEO_BACKEND_DISCLOSURES.map((b) => b.id)).toEqual(['local', 'grok']);
    expect(videoBackendDisclosure('local').execution).toBe('local');
    expect(videoBackendDisclosure('grok').execution).toBe('hosted');
    expect(videoBackendDisclosure('nope')).toBe(null);
  });

  it('says the local path adds no PortOS filter AND that licenses still apply', () => {
    const facts = videoBackendDisclosure('local').facts.join(' ');
    expect(facts).toMatch(/no model-level prompt filter/i);
    expect(facts).toMatch(/does not send your prompt/i);
    expect(facts).toMatch(/license/i);
  });

  it('says the hosted path leaves the machine and that provider rules apply', () => {
    const grok = videoBackendDisclosure('grok');
    expect(grok.provider).toBe('xAI');
    const facts = grok.facts.join(' ');
    expect(facts).toMatch(/sent to xAI/i);
    expect(facts).toMatch(/terms/i);
    expect(grok.links.length).toBeGreaterThan(0);
    for (const link of grok.links) expect(link.url).toMatch(/^https:\/\//);
  });

  it('never ranks a backend by restrictiveness', () => {
    for (const backend of VIDEO_BACKEND_DISCLOSURES) {
      const prose = [backend.summary, ...backend.facts].join(' ');
      // "That is a statement about PortOS, not a guarantee" is the one
      // sanctioned use of the word "guarantee"; ranking words are banned.
      expect(prose, backend.id).not.toMatch(RANKING_WORDS);
    }
  });
});
