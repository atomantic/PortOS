import { describe, expect, it } from 'vitest';
import { releaseTitleFromChangelog } from './releaseTitle.js';

describe('releaseTitleFromChangelog', () => {
  it('promotes the named first heading to the GitHub release title', () => {
    expect(releaseTitleFromChangelog('# Release v2.74.0 - Performant Dragon\n\n## Highlights', '2.74.0'))
      .toBe('Release v2.74.0 - Performant Dragon');
  });

  it('accepts Windows line endings without changing the title', () => {
    expect(releaseTitleFromChangelog('\r\n# Release v1.2.3 - Resilient Otter\r\n', '1.2.3'))
      .toBe('Release v1.2.3 - Resilient Otter');
  });

  it('falls back for legacy or mismatched unnamed notes', () => {
    expect(releaseTitleFromChangelog('# Release v2.74.0\n', '2.74.0')).toBe('Release v2.74.0');
    expect(releaseTitleFromChangelog('# Release v2.73.0 - Older Otter\n', '2.74.0')).toBe('Release v2.74.0');
  });
});
