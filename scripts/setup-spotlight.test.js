import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excludeFromSpotlight, SPOTLIGHT_MARKER } from './lib/spotlightExclude.js';
import { setupSpotlight } from './setup-spotlight.js';

describe('Spotlight exclusion of data/', () => {
  const dirs = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'spotlight-')); dirs.push(d); return d; };
  afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

  it('marks only the machinery dirs once on macOS, keeps media indexed, and skips other platforms', () => {
    const dir = tmp();
    expect(excludeFromSpotlight(dir, { platform: 'linux' })).toBe('unsupported');
    expect(existsSync(join(dir, 'cos/worktrees', SPOTLIGHT_MARKER))).toBe(false);
    expect(excludeFromSpotlight(dir, { platform: 'darwin' })).toBe('created');
    expect(existsSync(join(dir, 'cos/worktrees', SPOTLIGHT_MARKER))).toBe(true);
    expect(existsSync(join(dir, SPOTLIGHT_MARKER))).toBe(false);
    expect(existsSync(join(dir, 'videos', SPOTLIGHT_MARKER))).toBe(false);
    expect(excludeFromSpotlight(dir, { platform: 'darwin' })).toBe('present');
  });

  it('honors the opt-out without touching the directory', () => {
    const dir = join(tmp(), 'data');
    expect(setupSpotlight(dir, { log: () => {}, env: { PORTOS_SKIP_SPOTLIGHT_EXCLUDE: '1' } })).toBe('skipped');
    expect(existsSync(dir)).toBe(false);
  });
});
