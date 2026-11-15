import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES_MAX_BYTES, releaseNotesProblem, releaseTitleFromChangelog } from './releaseTitle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

describe('releaseNotesProblem', () => {
  it('accepts named and bare headings for the running version', () => {
    expect(releaseNotesProblem('# Release v2.74.0 - Performant Dragon\n\nbody', '2.74.0')).toBeNull();
    expect(releaseNotesProblem('# Release v2.74.0\n', '2.74.0')).toBeNull();
  });

  it('rejects stale notes for another version instead of publishing them', () => {
    expect(releaseNotesProblem('# Release v2.73.0 - Older Otter\n', '2.74.0')).toMatch(/does not name v2\.74\.0/);
    expect(releaseNotesProblem('no heading at all', '2.74.0')).toMatch(/does not name/);
  });

  it('refuses notes over the size limit rather than truncating them', () => {
    const big = `# Release v1.0.0 - Big Bear\n${'x'.repeat(RELEASE_NOTES_MAX_BYTES)}`;
    expect(releaseNotesProblem(big, '1.0.0')).toMatch(/over the \d+-byte limit/);
  });
});

describe('.changelog directory', () => {
  it('holds only the README and the running version\'s notes, within the size limit', () => {
    expect(readdirSync(join(repoRoot, '.changelog')).sort()).toEqual(['README.md', 'RELEASE.md']);
    const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(releaseNotesProblem(readFileSync(join(repoRoot, '.changelog/RELEASE.md'), 'utf8'), version)).toBeNull();
  });
});
