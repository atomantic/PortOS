import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { workflowJobs } from './lib/workflowJobs.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('release.yml full-ci permissions', () => {
  it('grants the release caller every scope a called ci.yml job declares', () => {
    // A called workflow cannot hold a scope its calling job lacks; a missing
    // grant is a startup_failure that publishes nothing (v2.97.0, statuses: read).
    const fullCi = workflowJobs(read('.github/workflows/release.yml'))['full-ci'];
    expect(fullCi).toBeTruthy();
    const granted = new Set([...fullCi.matchAll(/^ {6}(\w+): (?:read|write)$/gm)].map((m) => m[1]));
    for (const [id, body] of Object.entries(workflowJobs(read('.github/workflows/ci.yml')))) {
      const block = body.match(/\n    permissions:\n((?:      \w+: (?:read|write)\n)+)/);
      for (const m of (block?.[1] ?? '').matchAll(/ {6}(\w+): /g)) {
        expect(granted.has(m[1]), `${id} needs ${m[1]}`).toBe(true);
      }
    }
  });
});
