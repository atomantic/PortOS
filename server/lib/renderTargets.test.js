import { describe, it, expect } from 'vitest';
import { RENDER_TARGETS, RENDER_TARGET_OPTIONS, RENDER_TARGETS_WITHOUT_SETTINGS_ROW } from './renderTargets.js';

describe('render-target Settings rows (#3231)', () => {
  // A mistyped RENDER_TARGET member surfaces as an `undefined` row id here rather than as a 400 on the whole settings PUT.
  it('every Settings row names a real render target', () => {
    const targets = new Set(RENDER_TARGETS);
    for (const { id } of RENDER_TARGET_OPTIONS) {
      expect(targets.has(id), `RENDER_TARGET_OPTIONS id "${id}" is not in RENDER_TARGETS`).toBe(true);
    }
  });

  it('every render target is either listed or deliberately unlisted', () => {
    const listed = new Set(RENDER_TARGET_OPTIONS.map((o) => o.id));
    for (const id of RENDER_TARGETS) {
      expect(listed.has(id) || RENDER_TARGETS_WITHOUT_SETTINGS_ROW.includes(id),
        `render target "${id}" is in neither RENDER_TARGET_OPTIONS nor RENDER_TARGETS_WITHOUT_SETTINGS_ROW`).toBe(true);
    }
  });
});
