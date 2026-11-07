import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
import { NATIVE_USAGE_SQL_IMAGE } from './lib/nativeUsageSqlRehearsal.js';

const PINNED = /^pgvector\/pgvector:pg\d+@sha256:[0-9a-f]{64}$/;

// Regression caught: a tag-only database image makes installs at the same
// revision provision different PostgreSQL/pgvector contents depending on pull
// date. Digest changes must be explicit dependency-update PRs.
describe('database image is pinned to a manifest digest', () => {
  const sources = {
    'docker-compose.yml': readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'),
    '.github/workflows/ci.yml': readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
  };

  for (const [file, text] of Object.entries(sources)) {
    it(`${file} references every pgvector image by tag@digest`, () => {
      const refs = [...text.matchAll(/^\s*image:\s*(pgvector\/\S+)\s*$/gm)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toMatch(PINNED);
    });
  }

  it('compose and CI pin the same digest', () => {
    const digests = Object.values(sources).flatMap((t) => [...t.matchAll(/pgvector\/pgvector:pg\d+@(sha256:[0-9a-f]{64})/g)].map((m) => m[1]));
    expect(new Set([...digests, NATIVE_USAGE_SQL_IMAGE.split('@')[1]]).size).toBe(1);
  });
});

it('requires the real isolated SQL rehearsal in the hosted DB job without a memo or availability skip', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  expect(workflow).toMatch(/name: Rehearse isolated SQL restore\n\s+timeout-minutes: 5\n\s+env:\n\s+PORTOS_NATIVE_SQL_LIVE: '1'\n\s+run: cd server && node node_modules\/vitest\/vitest.mjs run --configLoader runner \.\.\/scripts\/native-usage-sql-rehearsal.live.test.js/);
});
