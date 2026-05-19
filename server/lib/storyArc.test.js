import { describe, it, expect, vi } from 'vitest';

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const {
  sanitizeArc,
  sanitizeSeason,
  sanitizeSeasonList,
  buildSeason,
  ARC_LIMITS,
  ARC_SHAPES,
  ARC_SHAPE_IDS,
  getArcShape,
  renderArcShapeGuidance,
  describeArcShapePositionForSeason,
} = await import('./storyArc.js');

describe('storyArc — sanitizeArc', () => {
  it('returns null for null/undefined/non-objects', () => {
    expect(sanitizeArc(null)).toBe(null);
    expect(sanitizeArc(undefined)).toBe(null);
    expect(sanitizeArc('arc')).toBe(null);
    expect(sanitizeArc(42)).toBe(null);
  });

  it('returns null when every identifying field is empty', () => {
    expect(sanitizeArc({})).toBe(null);
    expect(sanitizeArc({ logline: '', summary: '', protagonistArc: '', themes: [] })).toBe(null);
    expect(sanitizeArc({ logline: '   ', themes: ['', ' '] })).toBe(null);
  });

  it('round-trips the canonical shape with defaults filled in', () => {
    const arc = sanitizeArc({ logline: 'A cult, a city, a child.' });
    expect(arc).toEqual({
      logline: 'A cult, a city, a child.',
      summary: '',
      protagonistArc: '',
      themes: [],
      shape: null,
      status: 'draft',
    });
  });

  it('drops invalid status', () => {
    expect(sanitizeArc({ logline: 'x', status: 'bogus' }).status).toBe('draft');
    expect(sanitizeArc({ logline: 'x', status: 'verified' }).status).toBe('verified');
  });

  it('accepts allowed Vonnegut shape ids and nulls out anything else', () => {
    expect(sanitizeArc({ logline: 'x', shape: 'cinderella' }).shape).toBe('cinderella');
    expect(sanitizeArc({ logline: 'x', shape: 'man-in-hole' }).shape).toBe('man-in-hole');
    expect(sanitizeArc({ logline: 'x', shape: 'not-a-real-shape' }).shape).toBe(null);
    expect(sanitizeArc({ logline: 'x', shape: 42 }).shape).toBe(null);
    expect(sanitizeArc({ logline: 'x' }).shape).toBe(null);
  });

  it('treats a picked shape as identifying content (explicit narrative decision)', () => {
    const arc = sanitizeArc({ shape: 'cinderella' });
    expect(arc).not.toBe(null);
    expect(arc.shape).toBe('cinderella');
    expect(arc.logline).toBe('');
    // Invalid shape strings still fall through to "no arc"
    expect(sanitizeArc({ shape: 'not-a-shape' })).toBe(null);
  });

  it('trims fields to their cap and cleans themes', () => {
    const arc = sanitizeArc({
      logline: 'a'.repeat(ARC_LIMITS.LOGLINE_MAX + 50),
      themes: [' betrayal ', '', 'legacy', 'x'.repeat(ARC_LIMITS.THEME_MAX + 5)],
    });
    expect(arc.logline.length).toBe(ARC_LIMITS.LOGLINE_MAX);
    expect(arc.themes).toEqual(['betrayal', 'legacy', 'x'.repeat(ARC_LIMITS.THEME_MAX)]);
  });

  it('caps themes at THEMES_PER_ARC_MAX', () => {
    const many = Array.from({ length: ARC_LIMITS.THEMES_PER_ARC_MAX + 5 }, (_, i) => `t${i}`);
    expect(sanitizeArc({ logline: 'x', themes: many }).themes).toHaveLength(ARC_LIMITS.THEMES_PER_ARC_MAX);
  });
});

describe('storyArc — sanitizeSeason', () => {
  it('rejects entries with neither title nor positive number', () => {
    expect(sanitizeSeason({})).toBe(null);
    expect(sanitizeSeason({ number: 0 })).toBe(null);
    expect(sanitizeSeason({ title: '' })).toBe(null);
    expect(sanitizeSeason({ title: '   ' })).toBe(null);
  });

  it('builds a canonical season from a partial input', () => {
    const s = sanitizeSeason({ title: 'Diaspora', number: 2 });
    expect(s.id).toMatch(/^sea-/);
    expect(s.title).toBe('Diaspora');
    expect(s.number).toBe(2);
    expect(s.status).toBe('draft');
    expect(s.episodeCountTarget).toBe(0);
    expect(s.themes).toEqual([]);
    expect(s.createdAt).toMatch(/T/);
    // createdAt + updatedAt are two separate nowIso() calls so they may differ
    // by ms within the same tick. Just confirm both are present + ordered.
    expect(s.updatedAt >= s.createdAt).toBe(true);
  });

  it('preserves an existing sea- id', () => {
    const s = sanitizeSeason({ id: 'sea-existing', title: 'x' });
    expect(s.id).toBe('sea-existing');
  });

  it('regenerates a non-conforming id', () => {
    uuidCounter = 0;
    const s = sanitizeSeason({ id: 'not-a-season-id', title: 'x' });
    expect(s.id).toMatch(/^sea-uuid-/);
  });

  it('clamps numeric fields to caps', () => {
    const s = sanitizeSeason({
      title: 'x',
      number: ARC_LIMITS.SEASON_NUMBER_MAX + 99,
      episodeCountTarget: ARC_LIMITS.SEASON_EPISODE_COUNT_MAX + 999,
    });
    expect(s.number).toBe(ARC_LIMITS.SEASON_NUMBER_MAX);
    expect(s.episodeCountTarget).toBe(ARC_LIMITS.SEASON_EPISODE_COUNT_MAX);
  });

  it('refreshes timestamps when preserveTimestamps=false', async () => {
    const original = sanitizeSeason({ title: 'x', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    // Tick the clock forward so the new updatedAt is strictly greater
    await new Promise((r) => setTimeout(r, 5));
    const next = sanitizeSeason({ ...original, title: 'y' }, { preserveTimestamps: false });
    expect(next.createdAt).not.toBe(original.createdAt); // both flipped
    expect(next.updatedAt > original.updatedAt).toBe(true);
  });

  // `locked` defaults to false and only accepts strict-true so a typo
  // ("locked: 'yes'") can't accidentally freeze a season.
  it('defaults locked to false and coerces truthy non-booleans away', () => {
    expect(sanitizeSeason({ title: 'x' }).locked).toBe(false);
    expect(sanitizeSeason({ title: 'x', locked: false }).locked).toBe(false);
    expect(sanitizeSeason({ title: 'x', locked: 'yes' }).locked).toBe(false);
    expect(sanitizeSeason({ title: 'x', locked: 1 }).locked).toBe(false);
    expect(sanitizeSeason({ title: 'x', locked: true }).locked).toBe(true);
  });
});

describe('storyArc — sanitizeSeasonList', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeSeasonList(null)).toEqual([]);
    expect(sanitizeSeasonList({})).toEqual([]);
    expect(sanitizeSeasonList('s1,s2')).toEqual([]);
  });

  it('drops rejected entries and sorts by number ascending', () => {
    const out = sanitizeSeasonList([
      { title: 'A', number: 3 },
      { title: '' },              // dropped
      { title: 'B', number: 1 },
      { title: 'C', number: 2 },
    ]);
    expect(out.map((s) => s.title)).toEqual(['B', 'C', 'A']);
  });

  it('deduplicates by id (last write wins)', () => {
    const out = sanitizeSeasonList([
      { id: 'sea-dup', title: 'first', number: 1 },
      { id: 'sea-dup', title: 'second', number: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('second');
  });

  it('caps at SEASONS_PER_SERIES_MAX', () => {
    const many = Array.from({ length: ARC_LIMITS.SEASONS_PER_SERIES_MAX + 5 }, (_, i) => ({ title: `s${i}`, number: i + 1 }));
    expect(sanitizeSeasonList(many)).toHaveLength(ARC_LIMITS.SEASONS_PER_SERIES_MAX);
  });
});

describe('storyArc — Vonnegut shape catalog', () => {
  it('exports all 8 shapes, ids match the curve definitions', () => {
    expect(ARC_SHAPES).toHaveLength(8);
    expect(ARC_SHAPE_IDS).toEqual(ARC_SHAPES.map((s) => s.id));
    for (const shape of ARC_SHAPES) {
      expect(shape.id).toMatch(/^[a-z][a-z-]+$/);
      expect(shape.label).toBeTruthy();
      expect(shape.description).toBeTruthy();
      expect(shape.guidance.length).toBeGreaterThan(50);
      expect(shape.points).toHaveLength(7);
      // Each point in [-1, 1]
      for (const p of shape.points) {
        expect(p).toBeGreaterThanOrEqual(-1);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  // Lock the server-side `points` arrays to the client's `STORY_SHAPES`
  // definitions so the sparkline and the prompt guidance stay in sync.
  // (CLAUDE.md: "Keep `points` arrays in sync with client/.../StoryShapes.jsx".)
  it('points arrays match the client-side STORY_SHAPES curves', () => {
    const CLIENT_POINTS = {
      'rags-to-riches':  [-1, -0.7, -0.4, -0.1, 0.3, 0.7, 1],
      'tragedy':         [1, 0.7, 0.4, 0.1, -0.3, -0.7, -1],
      'man-in-hole':     [0.4, 0, -0.6, -1, -0.5, 0.3, 0.9],
      'icarus':          [-0.4, 0.2, 0.7, 1, 0.5, -0.2, -1],
      'cinderella':      [-0.7, -0.3, 0.2, 0.5, -0.3, 0.4, 1],
      'oedipus':         [0.3, -0.2, -0.7, 0.2, 0.5, 0, -1],
      'boy-meets-girl':  [0, 0.6, 0.9, 0.2, -0.5, 0.3, 0.9],
      'creation-story':  [-1, -1, -0.4, -0.4, 0.3, 0.3, 1],
    };
    for (const shape of ARC_SHAPES) {
      expect(shape.points).toEqual(CLIENT_POINTS[shape.id]);
    }
  });

  it('getArcShape returns the matching record or null', () => {
    expect(getArcShape('cinderella').label).toBe('Cinderella');
    expect(getArcShape('bogus')).toBe(null);
    expect(getArcShape(null)).toBe(null);
  });

  it('renderArcShapeGuidance returns null for unknown / missing shapes', () => {
    expect(renderArcShapeGuidance(null)).toBe(null);
    expect(renderArcShapeGuidance('')).toBe(null);
    expect(renderArcShapeGuidance('bogus')).toBe(null);
  });

  it('renderArcShapeGuidance produces a labeled, multi-line guidance block', () => {
    const out = renderArcShapeGuidance('rags-to-riches');
    expect(out).toContain('Rags to Riches');
    expect(out).toContain('rags-to-riches');
    expect(out).toContain('monotonically');
  });
});

describe('storyArc — describeArcShapePositionForSeason', () => {
  it('returns null for unknown shape or invalid totals', () => {
    expect(describeArcShapePositionForSeason('bogus', 1, 3)).toBe(null);
    expect(describeArcShapePositionForSeason('rags-to-riches', 0, 3)).toBe(null);
    expect(describeArcShapePositionForSeason('rags-to-riches', 4, 3)).toBe(null);
    expect(describeArcShapePositionForSeason('rags-to-riches', 1, 0)).toBe(null);
  });

  it('places season 1 of N at the opening, season N of N at the terminal', () => {
    const opening = describeArcShapePositionForSeason('rags-to-riches', 1, 3);
    const finale  = describeArcShapePositionForSeason('rags-to-riches', 3, 3);
    expect(opening.fortune).toBeLessThan(-0.5);   // opens at the bottom
    expect(finale.fortune).toBeGreaterThan(0.5);  // ends at the top
    expect(opening.movement).toBe('opening position');
    expect(finale.movement).toContain('climb');
  });

  it('detects the man-in-hole midpoint as the nadir', () => {
    // Volume 2 of 3 in man-in-hole hits the deepest point in the 7-pt curve.
    const mid = describeArcShapePositionForSeason('man-in-hole', 2, 3);
    expect(mid.level).toMatch(/nadir|low/);
    expect(mid.movement).toContain('fall');
  });

  it('handles single-season arcs by sampling the curve midpoint', () => {
    const only = describeArcShapePositionForSeason('icarus', 1, 1);
    expect(only).not.toBe(null);
    expect(only.movement).toBe('opening position');
    // icarus midpoint is the peak
    expect(only.fortune).toBeGreaterThan(0.5);
  });

  it('summary string names the volume and the shape', () => {
    const out = describeArcShapePositionForSeason('cinderella', 2, 3);
    expect(out.summary).toContain('Volume 2 of 3');
    expect(out.summary).toContain('Cinderella');
  });
});

describe('storyArc — buildSeason', () => {
  it('always produces a sea- prefixed id and fresh timestamps', () => {
    uuidCounter = 100;
    const s = buildSeason({ title: 'Pilot', number: 1 });
    expect(s.id).toMatch(/^sea-uuid-/);
    expect(s.createdAt).toBe(s.updatedAt);
  });

  it('returns null when the input has no identifying content', () => {
    expect(buildSeason({})).toBe(null);
    expect(buildSeason({ logline: 'just a logline' })).toBe(null);
  });
});
