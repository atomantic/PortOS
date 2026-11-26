// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { musicVideoFilmApi } from './apiMusicVideo.js';
import { codeAnimationFilmApi } from './apiCodeAnimationFilm.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_REEXPORT = /\bexport\s+\*\s+(?:as\s+\w+\s+)?from\s+['"]\.\/api[A-Za-z0-9_]+(?:\.js)?['"]/g;

const sourceFiles = readdirSync(HERE).filter(
  (f) => (f.endsWith('.js') || f.endsWith('.jsx'))
    && !f.endsWith('.test.js') && !f.endsWith('.test.jsx'),
);

describe('client/src/services/ catalog', () => {
  it('exposes the standalone film adapter independently of the Music Video transport', () => {
    expect(typeof musicVideoFilmApi.getMusicVideoBlender).toBe('function');
    expect(typeof codeAnimationFilmApi.getMusicVideoBlender).toBe('function');
    expect(codeAnimationFilmApi.getMusicVideoBlender).not.toBe(musicVideoFilmApi.getMusicVideoBlender);
    const mediaPath = 's010/first frame.png';
    expect(musicVideoFilmApi.musicVideoBlenderMediaUrl('music video', mediaPath))
      .toBe('/api/music-video/music%20video/blender/media?path=s010%2Ffirst%20frame.png');
    expect(codeAnimationFilmApi.musicVideoBlenderMediaUrl('standalone film', mediaPath))
      .toBe('/api/code-animation/films/standalone%20film/blender/media?path=s010%2Ffirst%20frame.png');
  });

  it('forbids re-introducing an all-domain services/api.js barrel (#17007)', () => {
    expect(
      existsSync(join(HERE, 'api.js')),
      'services/api.js was retired (#17007) — import domain apiX.js modules directly',
    ).toBe(false);

    const barrels = sourceFiles.filter((file) => {
      const src = readFileSync(join(HERE, file), 'utf8');
      return (src.match(API_REEXPORT) || []).length >= 3;
    });
    expect(
      barrels,
      'do not aggregate domain apiX.js modules into a shared barrel (#17007)',
    ).toEqual([]);
  });
});
