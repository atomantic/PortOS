// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildLightboxMeta, describeCleanedLineage, formatDraftDecodeLabel, formatSpeedProfileLabel } from './lightboxMeta.js';

describe('lightboxMeta', () => {
  it('drops empty rows and keeps populated ones', () => {
    const meta = buildLightboxMeta({ modelId: 'm1', steps: 20, width: 512, height: 768, kind: 'image' }, false);
    expect(Object.fromEntries(meta)).toMatchObject({ Model: 'm1', Steps: 20, Resolution: '512×768' });
    expect(meta.some(([k]) => k === 'Universe')).toBe(false);
  });

  it('never presents an unreported speed profile or draft decode as applied', () => {
    expect(formatSpeedProfileLabel({ raw: { speedProfileId: 'fast' } })).toBe('fast — outcome not reported');
    expect(formatDraftDecodeLabel({ raw: { draftDecode: 'tae' } })).toBe('tae — outcome not reported');
    expect(formatDraftDecodeLabel({ raw: { draftDecode: 'tae', draftDecodeApplied: { applied: false, reason: 'oom' } } }))
      .toBe('full decoder (tae unavailable: oom)');
  });

  it('describes cleaned lineage variants', () => {
    expect(describeCleanedLineage({ autoCleaned: true, c2paStripped: true })).toBe('Auto-cleaned (aggressive) · C2PA stripped');
    expect(describeCleanedLineage({ watermarkRemoved: true, cleanedFrom: 'a.png' })).toBe('Watermark removed from a.png');
    expect(describeCleanedLineage({})).toBeNull();
  });
});
