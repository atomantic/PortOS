import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNKNOWN_LICENSE_LABEL,
  buildProvenance,
  buildProvenanceSource,
  huggingfaceUrl,
  licenseFromCivitaiModel,
  licenseFromHuggingFaceModel,
  licenseLabel,
  normalizeLicense,
  provenanceForRender,
  readProvenance,
  resolveAssetProvenance,
  rollupProvenance,
} from './assetProvenance.js';

describe('normalizeLicense / licenseLabel', () => {
  it('treats blank, whitespace, and non-strings as unknown (null)', () => {
    expect(normalizeLicense('')).toBeNull();
    expect(normalizeLicense('   ')).toBeNull();
    expect(normalizeLicense(null)).toBeNull();
    expect(normalizeLicense(undefined)).toBeNull();
    expect(normalizeLicense(42)).toBeNull();
    expect(licenseLabel(null)).toBe(UNKNOWN_LICENSE_LABEL);
    expect(licenseLabel('  ')).toBe(UNKNOWN_LICENSE_LABEL);
  });
  it('never infers a permissive default from absence', () => {
    expect(licenseLabel(undefined)).toBe('unknown');
    expect(licenseLabel('mit')).toBe('mit');
  });
});

describe('licenseFromHuggingFaceModel', () => {
  it('prefers cardData.license, then license, then a license: tag', () => {
    expect(licenseFromHuggingFaceModel({ cardData: { license: 'apache-2.0' } })).toBe('apache-2.0');
    expect(licenseFromHuggingFaceModel({ license: 'mit' })).toBe('mit');
    expect(licenseFromHuggingFaceModel({ tags: ['text-to-image', 'license:openrail'] })).toBe('openrail');
  });
  it('returns null when nothing is observable', () => {
    expect(licenseFromHuggingFaceModel({})).toBeNull();
    expect(licenseFromHuggingFaceModel({ tags: ['flux'] })).toBeNull();
  });
});

describe('licenseFromCivitaiModel', () => {
  it('reads the license string and ignores allowCommercialUse', () => {
    expect(licenseFromCivitaiModel({ license: 'CreativeML Open RAIL-M' })).toBe('CreativeML Open RAIL-M');
    expect(licenseFromCivitaiModel({ allowCommercialUse: 'Sell' })).toBeNull();
    expect(licenseFromCivitaiModel({ license: '', allowCommercialUse: 'Sell' })).toBeNull();
  });
});

describe('buildProvenance / provenanceForRender', () => {
  it('stamps model + LoRA sources with unknown licenses as null', () => {
    const p = provenanceForRender({
      model: { id: 'flux2-klein-9b', name: 'FLUX.2 Klein 9B', repo: 'org/flux2' },
      loras: [{ filename: 'lora-style.safetensors', license: 'openrail', sourceUrl: 'https://civitai.com/models/1' }],
      capturedAt: '2026-09-02T12:00:00.000Z',
    });
    expect(p.schemaVersion).toBe(1);
    expect(p.capturedAt).toBe('2026-09-02T12:00:00.000Z');
    expect(p.sources).toEqual([
      {
        kind: 'model',
        id: 'flux2-klein-9b',
        name: 'FLUX.2 Klein 9B',
        license: null,
        sourceUrl: 'https://huggingface.co/org/flux2',
      },
      {
        kind: 'lora',
        id: 'lora-style.safetensors',
        name: null,
        license: 'openrail',
        sourceUrl: 'https://civitai.com/models/1',
      },
    ]);
  });
  it('uses disclosure.weightsLicense and never runtimeLicense', () => {
    const p = provenanceForRender({
      model: {
        id: 'ltx-2.3',
        name: 'LTX 2.3',
        disclosure: {
          modelCardUrl: 'https://huggingface.co/Lightricks/LTX-2.3',
          weightsLicense: { name: 'Apache-2.0', url: 'https://huggingface.co/Lightricks/LTX-2.3' },
          runtimeLicense: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
        },
      },
    });
    expect(p.sources[0].license).toBe('Apache-2.0');
    expect(p.sources[0].sourceUrl).toBe('https://huggingface.co/Lightricks/LTX-2.3');
  });

  it('drops unusable sources and dedupes by kind+id, preferring a known license', () => {
    const p = buildProvenance({
      sources: [
        { kind: 'model', id: 'm', license: null },
        { kind: 'model', id: 'm', license: 'mit', name: 'M' },
        { kind: 'weird', id: 'x' },
        { kind: 'lora', id: '' },
      ],
    });
    expect(p.sources).toEqual([
      { kind: 'model', id: 'm', name: 'M', license: 'mit', sourceUrl: null },
    ]);
  });
});

describe('readProvenance / resolveAssetProvenance', () => {
  it('returns stamped provenance as-is and does not re-derive licenses', () => {
    const record = {
      modelId: 'flux2-klein-9b',
      provenance: {
        schemaVersion: 1,
        capturedAt: '2026-01-01T00:00:00.000Z',
        sources: [{ kind: 'model', id: 'flux2-klein-9b', license: null, name: 'Klein', sourceUrl: null }],
      },
    };
    const resolved = resolveAssetProvenance(record);
    expect(resolved.reconstructed).toBe(false);
    expect(resolved.sources[0].license).toBeNull();
  });
  it('reconstructs unknown-license sources from sidecar fields when provenance is missing', () => {
    const resolved = resolveAssetProvenance({
      modelId: 'flux2-klein-9b',
      loraFilenames: ['lora-style.safetensors'],
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    expect(resolved.reconstructed).toBe(true);
    expect(resolved.sources.map((s) => s.id)).toEqual(['flux2-klein-9b', 'lora-style.safetensors']);
    expect(resolved.sources.every((s) => s.license == null)).toBe(true);
  });
  it('returns null when there is nothing to attribute', () => {
    expect(resolveAssetProvenance({})).toBeNull();
    expect(readProvenance({ provenance: { sources: [] } })).toBeNull();
  });
});

describe('rollupProvenance', () => {
  it('unions distinct sources across a collection of assets', () => {
    const rollup = rollupProvenance([
      {
        provenance: {
          sources: [
            { kind: 'model', id: 'a', license: 'mit' },
            { kind: 'lora', id: 'x.safetensors', license: null },
          ],
        },
      },
      {
        provenance: {
          sources: [
            { kind: 'model', id: 'a', license: 'mit' },
            { kind: 'model', id: 'b', license: 'apache-2.0' },
          ],
        },
      },
    ]);
    expect(rollup.sources.map((s) => s.id)).toEqual(['a', 'x.safetensors', 'b']);
  });
});

describe('huggingfaceUrl', () => {
  it('builds a Hub URL from a repo id and rejects blanks', () => {
    expect(huggingfaceUrl('org/name')).toBe('https://huggingface.co/org/name');
    expect(huggingfaceUrl('  ')).toBeNull();
    expect(huggingfaceUrl(null)).toBeNull();
  });
});

describe('buildProvenanceSource', () => {
  it('rejects unknown kinds and empty ids', () => {
    expect(buildProvenanceSource({ kind: 'runtime', id: 'x' })).toBeNull();
    expect(buildProvenanceSource({ kind: 'model', id: '' })).toBeNull();
  });
});

describe('client mirror', () => {
  it('stays byte-for-byte with client/src/lib/assetProvenance.js', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const server = readFileSync(join(here, 'assetProvenance.js'), 'utf8');
    const client = readFileSync(join(here, '../../client/src/lib/assetProvenance.js'), 'utf8');
    expect(client).toBe(server);
  });
});
