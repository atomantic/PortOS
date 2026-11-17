import { execFileSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { PINNED_DB_IMAGE, PINNED_DB_MAJOR, readPinnedDbImage } from './lib/dbImage.js';

const PINNED = /^pgvector\/pgvector:pg\d+@sha256:[0-9a-f]{64}$/;

// Regression caught: a tag-only database image makes installs at the same
// revision provision different PostgreSQL/pgvector contents depending on pull
// date. Digest changes must be explicit dependency-update PRs.
describe('database image is pinned to a manifest digest', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('docker-compose.yml references every pgvector image by tag@digest', () => {
    const refs = [...compose.matchAll(/^\s*image:\s*(pgvector\/\S+)\s*$/gm)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(PINNED);
    expect(PINNED_DB_IMAGE).toBe(refs[0]);
  });

  // Regression caught: Dependabot's docker-compose ecosystem edits only
  // docker-compose.yml, so any second literal copy fails every bump PR.
  it('the digest literal appears in no tracked file but docker-compose.yml', () => {
    const digest = PINNED_DB_IMAGE.split('@')[1];
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
    const holders = files.filter((f) => {
      const p = join(ROOT, f);
      return statSync(p, { throwIfNoEntry: false })?.isFile() && readFileSync(p).includes(digest);
    });
    expect(holders).toEqual(['docker-compose.yml']);
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

it('requires the live pg_dump restore in the hosted DB job without a memo or availability skip', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  expect(workflow).toMatch(/name: Restore a real pg_dump into a scratch database\n\s+timeout-minutes: \d+\n\s+env:\n\s+PORTOS_DB_RESTORE_LIVE: '1'\n\s+PGMODE: native\n\s+run: cd server && npx --no-install vitest run services\/backupDatabaseDump\.restore\.live\.test\.js\n/);
});
