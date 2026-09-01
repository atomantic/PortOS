import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './330-brain-link-repo-fields.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 330 — brain link repository fields', () => {
  let rootDir;
  let linksDir;

  const writeLink = (id, record) => {
    mkdirSync(join(linksDir, id), { recursive: true });
    writeJson(join(linksDir, id, 'index.json'), record);
  };
  const readLink = (id) => readJson(join(linksDir, id, 'index.json'));

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-328-'));
    linksDir = join(rootDir, 'data', 'brain', 'links');
    mkdirSync(linksDir, { recursive: true });
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('does nothing on an install with no brain links directory', async () => {
    rmSync(join(rootDir, 'data'), { recursive: true, force: true });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
  });

  it('renames the GitHub-only fields and keeps the legacy mirror for older peers', async () => {
    writeLink('link-a', {
      id: 'link-a',
      url: 'https://github.com/example-owner/example-repo',
      linkType: 'github',
      isGitHubRepo: true,
      gitHubOwner: 'example-owner',
      gitHubRepo: 'example-repo',
      localPath: '/repos/example-owner/example-repo',
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });

    expect(readLink('link-a')).toMatchObject({
      linkType: 'repo',
      isRepo: true,
      repoHost: 'github.com',
      repoOwner: 'example-owner',
      repoName: 'example-repo',
      // Federation compatibility: a peer on older code still reads these.
      isGitHubRepo: true,
      gitHubOwner: 'example-owner',
      gitHubRepo: 'example-repo',
      localPath: '/repos/example-owner/example-repo',
    });
  });

  it('leaves plain bookmarks, tombstones, and already-migrated records untouched', async () => {
    writeLink('bookmark', { id: 'bookmark', url: 'https://example.com', linkType: 'article', isGitHubRepo: false });
    writeLink('gone', { id: 'gone', _deleted: true, updatedAt: '2026-01-01T00:00:00.000Z' });
    writeLink('fresh', {
      id: 'fresh',
      url: 'https://gitlab.com/example-group/example-repo',
      linkType: 'repo',
      isRepo: true,
      repoHost: 'gitlab.com',
      repoOwner: 'example-group',
      repoName: 'example-repo',
      isGitHubRepo: false,
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });

    expect(readLink('bookmark')).not.toHaveProperty('isRepo');
    expect(readLink('gone')).toEqual({ id: 'gone', _deleted: true, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(readLink('fresh')).toMatchObject({ repoHost: 'gitlab.com', isRepo: true });
  });

  it('is idempotent across a re-run', async () => {
    writeLink('link-a', {
      id: 'link-a',
      url: 'https://github.com/example-owner/example-repo',
      linkType: 'github',
      isGitHubRepo: true,
      gitHubOwner: 'example-owner',
      gitHubRepo: 'example-repo',
    });

    await migration.up({ rootDir });
    const afterFirst = readLink('link-a');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(readLink('link-a')).toEqual(afterFirst);
  });
});
