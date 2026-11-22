/**
 * Rule: no `bg-black/NN` scrim may carry `text-white` / `text-gray-[1-4]00` (any variant or alpha) outside `.always-dark`.
 * Fix: use `.port-media-overlay` / `-strong` (+ `-item` on buttons) from `index.css`, or `always-dark` when the surface is fixed-dark.
 * What this guard cannot see:
 *   - A scrim and its text split across different lines or elements.
 *   - Text colors set by a shared helper's class string.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

const SCRIM = /(?:^|[\s"'`:])bg-black\/\d+/;
const LIGHT_INK = /(?:^|[\s"'`:])text-(?:white|gray-[1-4]00)(?:\/\d+)?(?=[\s"'`]|$)/;

/** Files whose scrim sits inside a root element that carries `always-dark` (checked below). */
const ALWAYS_DARK_ROOT_FILES = new Set(['src/components/media/MediaLightbox.jsx']);

describe('media overlay conventions', () => {
  it('no bg-black/NN scrim with light text outside .always-dark', () => {
    const offenders = [];
    for (const file of trackedSourceFiles(CLIENT_ROOT)) {
      const src = readText(join(CLIENT_ROOT, file));
      const rel = file;
      const rootPinned = ALWAYS_DARK_ROOT_FILES.has(rel) && src.includes('always-dark');
      src.split('\n').forEach((line, i) => {
        if (!SCRIM.test(line) || !LIGHT_INK.test(line)) return;
        if (rootPinned || line.includes('always-dark')) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the lightbox root stays pinned always-dark', () => {
    const src = readText(join(REPO_ROOT, 'client/src/components/media/MediaLightbox.jsx'));
    expect(src).toMatch(/fixed inset-0 z-50 always-dark bg-black\/90/);
  });
});
