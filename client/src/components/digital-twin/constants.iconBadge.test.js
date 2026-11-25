// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ENRICHMENT_CATEGORIES, ICON_BADGE_CLASSES, iconBadgeClasses } from './constants';

// Regression: runtime-interpolated `bg-${color}-500/20` classes are not emitted by
// Tailwind, so every badge color must resolve through the static map.
describe('iconBadgeClasses', () => {
  it('maps every enrichment category color to literal bg/text classes', () => {
    for (const config of Object.values(ENRICHMENT_CATEGORIES)) {
      expect(ICON_BADGE_CLASSES[config.color], config.id).toBeDefined();
      expect(iconBadgeClasses(config.color).bg).toBe(`bg-${config.color}-500/20`);
      expect(iconBadgeClasses(config.color).text).toBe(`text-${config.color}-400`);
    }
  });

  it('falls back to blue for an unknown color', () => {
    expect(iconBadgeClasses(undefined)).toEqual(ICON_BADGE_CLASSES.blue);
  });
});
