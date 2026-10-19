/**
 * Port-band prose guard (#11851).
 *
 * PortOS owns the 5553–5569 band, documented once in `docs/PORTS.md`. Prose that
 * still says the band ends at 5561 hides the extension sidecars (whisper, the
 * Eidoverse bridge, llama-server) from operators and agents, and the README
 * security note then leaves the wildcard-bound :5563 bridge out of scope.
 *
 * The only tracked line allowed to spell out the old range is the core-services
 * row in `docs/PORTS.md`. Enumeration is a `git grep` over tracked markdown, so
 * the file that reintroduces the range is never imported by this test. That is
 * why it is registered in `ALWAYS_RUN_TESTS` rather than left to impact selection.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const STALE_BAND = '5553[-–]5561';
// Historical records and the plan archive legitimately quote the old range.
const EXCLUDED_PATHSPECS = [':!.changelog', ':!docs/plans', ':!docs/research'];
const ALLOWED = [{ file: 'docs/PORTS.md', line: '| 5553-5561 | PortOS core services' }];

/** `git grep` exits 1 on zero matches; that is an empty result, not a failure. */
function gitGrep(pattern, pathspecs) {
  try {
    return execFileSync('git', ['grep', '-nE', pattern, '--', ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.status === 1) return '';
    throw err;
  }
}

describe('PortOS port band in tracked markdown (#11851)', () => {
  it('no tracked markdown states the stale 5553-5561 band outside the PORTS.md core-services row', () => {
    const hits = gitGrep(STALE_BAND, ['*.md', ...EXCLUDED_PATHSPECS])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const firstColon = line.indexOf(':');
        const secondColon = line.indexOf(':', firstColon + 1);
        return { file: line.slice(0, firstColon), text: line.slice(secondColon + 1) };
      })
      .filter(({ file, text }) => !ALLOWED.some((a) => a.file === file && text.includes(a.line)));

    expect(hits.map(({ file, text }) => `${file}: ${text.trim()}`)).toEqual([]);
  });

  it('the scan actually reads the tracked PORTS.md core row (detector self-check)', () => {
    // If the pathspec ever widened to nothing, the assertion above would pass vacuously.
    const scanned = gitGrep(STALE_BAND, ['docs/PORTS.md']);
    expect(scanned).toContain('| 5553-5561 | PortOS core services');
  });
});
