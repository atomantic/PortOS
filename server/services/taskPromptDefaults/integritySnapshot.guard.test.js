/** Retired hashes are irreplaceable cross-install upgrade recognition data. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROMPT_VERSIONS } from './versions.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SNAPSHOT_PATH = 'server/services/taskPromptDefaults/integrity.snapshot.json';
const git = (...args) => execFileSync('git', args, {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function missingRetiredHashes(base, current, versions) {
  return Object.entries(base.PREVIOUS_DEFAULT_PROMPTS).flatMap(([key, hashes]) => {
    // Matches advancePromptIntegritySnapshot's intentional dropped-key handling.
    if (versions[key] === undefined) return [];
    const retained = new Set(current.PREVIOUS_DEFAULT_PROMPTS[key] ?? []);
    return hashes.filter((hash) => !retained.has(hash)).map((hash) => `${key}: ${hash}`);
  });
}

describe('retired prompt hash history (#11992)', () => {
  it('preserves every base hash for prompts that remain versioned', (context) => {
    const explicitBase = process.env.CI_BASE_SHA?.trim();
    let base;
    if (explicitBase) {
      // The planner already chose this commit. Do not rebase it, fall back, or
      // skip a bad explicit SHA: that would silently compare different inputs.
      base = git('rev-parse', '--verify', `${explicitBase}^{commit}`);
    } else {
      try {
        base = git('merge-base', 'origin/main', 'HEAD');
      } catch {
        context.skip('No merge base available; fetch origin/main to check retired prompt history.');
        return;
      }
    }
    // A resolvable base with a missing/malformed snapshot is an error, not an
    // empty history. Only an unavailable local base permits skipping.
    const previous = JSON.parse(git('show', `${base}:${SNAPSHOT_PATH}`));
    const current = JSON.parse(readFileSync(new URL('./integrity.snapshot.json', import.meta.url), 'utf8'));
    expect(missingRetiredHashes(previous, current, PROMPT_VERSIONS),
      `Retired prompt hashes removed since ${base}; restore this upgrade recognition history`,
    ).toEqual([]);
  });

  const snapshot = (history) => ({ PREVIOUS_DEFAULT_PROMPTS: history });
  const base = snapshot({ prompt: ['first', 'second'] });

  it.each([
    ['one hash', { prompt: ['second'] }, ['prompt: first']],
    ['the entire key', {}, ['prompt: first', 'prompt: second']],
  ])('detects deletion of %s', (_name, history, missing) => {
    expect(missingRetiredHashes(base, snapshot(history), { prompt: 2 })).toEqual(missing);
  });

  it('allows new hashes without depending on order', () => {
    expect(missingRetiredHashes(base, snapshot({ prompt: ['third', 'second', 'first'] }), { prompt: 3 })).toEqual([]);
  });

  it('allows history removal only after the prompt version key is removed', () => {
    expect(missingRetiredHashes(base, snapshot({}), {})).toEqual([]);
  });
});
