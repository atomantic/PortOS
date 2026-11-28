import { execFileSync } from 'child_process';
import { statSync } from 'fs';
import { readFile } from 'node:fs/promises';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

import { PINNED_DB_IMAGE, PINNED_DB_MAJOR, readPinnedDbImage } from '../../../../scripts/lib/dbImage.js';
import { guardCorpus, readText, REPO_ROOT as ROOT } from '../../../../scripts/lib/guardCorpus.js';

const PINNED = /^pgvector\/pgvector:pg\d+@sha256:[0-9a-f]{64}$/;

// Regression caught: a tag-only database image makes installs at the same
// revision provision different PostgreSQL/pgvector contents depending on pull
// date. Digest changes must be explicit dependency-update PRs.
describe('database image is pinned to a manifest digest', () => {
  const compose = readText(join(ROOT, 'docker-compose.yml'));
  const ci = readText(join(ROOT, '.github/workflows/ci.yml'));

  it('docker-compose.yml references every pgvector image by tag@digest', () => {
    const refs = [...compose.matchAll(/^\s*image:\s*(pgvector\/\S+)\s*$/gm)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(PINNED);
    expect(PINNED_DB_IMAGE).toBe(refs[0]);
  });

  // Regression caught: Dependabot's docker-compose ecosystem edits only
  // docker-compose.yml, so any second literal copy fails every bump PR.
  it('the digest literal appears in no tracked file but docker-compose.yml', async () => {
    const digest = Buffer.from(PINNED_DB_IMAGE.split('@')[1]);
    const corpus = guardCorpus();
    // A symlink counts by what it points at, as `statSync` sees it.
    const isFile = (f) => {
      const stats = corpus.lstat(f);
      return stats?.isSymbolicLink() ? statSync(join(ROOT, f), { throwIfNoEntry: false })?.isFile() : stats?.isFile();
    };
    const files = corpus.tracked().filter(isFile);
    const holders = [];
    let next = 0;
    // Bound in-flight reads and let each buffer go after searching so each
    // overlapping pregate does not retain a second copy of the whole checkout.
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < files.length) {
        const file = files[next++];
        if ((await readFile(join(ROOT, file))).includes(digest)) holders.push(file);
      }
    }));
    expect(holders.sort()).toEqual(['docker-compose.yml']);
  });

  // Regression caught: a dependency refresh that moves the tag to a new major
  // leaves every existing Docker volume unable to start.
  it(`the pin stays on the PostgreSQL ${PINNED_DB_MAJOR} line its volumes were created with`, () => {
    expect(Number(PINNED_DB_IMAGE.match(/:pg(\d+)@/)[1])).toBe(PINNED_DB_MAJOR);
  });

  it('the CI DB service takes its image from the impact job, which prints the compose pin', () => {
    expect(ci).toMatch(/services:\n\s+postgres:\n\s+image: \$\{\{ needs\.impact\.outputs\.db_image \}\}\n/);
    expect(ci).toContain('db_image: ${{ steps.db-image.outputs.image }}');
    expect(execFileSync('node', [join(ROOT, 'scripts/lib/dbImage.js')], { encoding: 'utf8' }).trim()).toBe(PINNED_DB_IMAGE);
  });

  it('readPinnedDbImage follows a changed digest and refuses a compose file with no pgvector image', () => {
    const bumped = `pgvector/pgvector:pg17@sha256:${'a'.repeat(64)}`;
    expect(readPinnedDbImage(compose.replace(PINNED_DB_IMAGE, bumped))).toBe(bumped);
    expect(() => readPinnedDbImage('services: {}')).toThrow(/no pgvector/);
  });
});

it('runs the selected live pg_dump restore without a memo or availability skip', () => {
  const workflow = readText(join(ROOT, '.github/workflows/ci.yml'));
  expect(workflow).toMatch(/name: Restore a real pg_dump into a scratch database\n\s+if: fromJSON\(needs\.impact\.outputs\.plan\)\.db_live_restore\n\s+timeout-minutes: \d+\n\s+env:\n\s+PORTOS_DB_RESTORE_LIVE: '1'\n\s+PGMODE: native\n\s+run: cd server && npx --no-install vitest run --configLoader native services\/backupDatabaseDump\.restore\.live\.test\.js\n/);
});
