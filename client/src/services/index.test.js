import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as barrel from './api.js';
import * as musicVideo from './apiMusicVideo.js';
import * as film from './apiCodeAnimationFilm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'api.js'), 'utf8');
const README_SRC = readFileSync(join(HERE, 'README.md'), 'utf8');

const sourceFiles = readdirSync(HERE).filter(
  (f) => (f.endsWith('.js') || f.endsWith('.jsx'))
    && !f.endsWith('.test.js') && !f.endsWith('.test.jsx')
    && f !== 'api.js',
);

const apiFiles = sourceFiles.filter((f) => f.startsWith('api') && f.endsWith('.js'));

describe('client/src/services/ catalog', () => {
  it('exposes the standalone film adapter without shadowing the Music Video transport', () => {
    expect(barrel.getMusicVideoBlender).toBe(musicVideo.getMusicVideoBlender);
    expect(barrel.codeAnimationFilm.getMusicVideoBlender).toBe(film.getMusicVideoBlender);
  });

  it('re-exports every apiX.js from api.js', () => {
    expect(Object.keys(barrel).length).toBeGreaterThan(0);
    for (const f of apiFiles) {
      expect(BARREL_SRC, `missing barrel re-export for ${f}`).toContain(`'./${f}'`);
    }
  });

  it('lists every source file exactly once in the alphabetical module table', () => {
    const section = README_SRC.split(/^## Modules$/m)[1]?.split(/^## /m)[0] ?? '';
    const table = section.match(/\|[^\n]+\|\n\|[-| ]+\|\n(?:\|[^\n]+\|\n)+/)?.[0] ?? '';
    const rows = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    expect(section.match(/^\| `[^`]+` \|/gm) ?? [], 'rows must be in the contiguous module table').toHaveLength(rows.length);
    const files = [...sourceFiles, 'api.js'].map((f) => f);
    expect(files.filter((f) => !rows.includes(f)), 'missing README rows').toEqual([]);
    expect(rows.filter((f, i) => rows.indexOf(f) !== i), 'duplicate README rows').toEqual([]);
    expect(rows.filter((f) => !files.includes(f)), 'stale README rows').toEqual([]);
    const sorted = [...rows].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    expect(rows, 'README rows must be in case-insensitive code-point order').toEqual(sorted);
  });
});
// @vitest-environment node
