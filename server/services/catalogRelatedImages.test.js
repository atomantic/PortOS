import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn() }));
vi.mock('../lib/pathSafety.js', () => ({ resolveGalleryImage: () => null, resolveImageRef: () => null }));

import { query } from '../lib/db.js';
import { listRelatedImages } from './catalogRelatedImages.js';

describe('related image provenance', () => {
  it('does not present CLI driver inputs as verified provider inputs, including older sidecars', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 7, items: [
      { filename: 'old-codex.png', _mode: 'codex', association: 'reference-input', provenanceStatus: 'recorded' },
      { filename: 'new-codex.png', _mode: 'codex', association: 'reference-input', provenanceStatus: 'legacy-unverified' },
      { filename: 'old-grok.png', _mode: 'grok', association: 'reference-input', provenanceStatus: 'recorded' },
      { filename: 'new-agy.png', _mode: 'agy', association: 'reference-input', provenanceStatus: 'legacy-unverified' },
      { filename: 'codex-derived.png', _mode: 'codex', association: 'derived-image', provenanceStatus: 'recorded' },
      { filename: 'codex-omitted.png', _mode: 'codex', association: 'reference-input', provenanceStatus: 'not-supplied' },
      { filename: 'other-provider.png', _mode: 'fal', association: 'reference-input', provenanceStatus: 'recorded' },
    ] }] });

    const result = await listRelatedImages({ payload: { primaryImageRef: 'source.png' } }, [], { limit: 10, offset: 0 });
    expect(result.items.map(({ filename, provenanceStatus }) => [filename, provenanceStatus])).toEqual([
      ['old-codex.png', 'provider-use-unverified'],
      ['new-codex.png', 'provider-use-unverified'],
      ['old-grok.png', 'provider-use-unverified'],
      ['new-agy.png', 'provider-use-unverified'],
      ['codex-derived.png', 'recorded'],
      ['codex-omitted.png', 'not-supplied'],
      ['other-provider.png', 'recorded'],
    ]);
    expect(result.items.every(item => !('_mode' in item))).toBe(true);
  });
});
