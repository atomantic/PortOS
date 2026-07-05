import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

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
  sanitizeReaderMap,
  sanitizeTickingClock,
  sanitizeForeshadowing,
  sanitizeForeshadowingEntry,
  FORESHADOW_LIMITS,
  renderTickingClock,
  TICKING_CLOCK_LIMITS,
  TICKING_CLOCK_KINDS,
  ARC_LIMITS,
  ARC_SHAPES,
  ARC_SHAPE_IDS,
  READER_MAP_LIMITS,
  READER_MAP_BEAT_KINDS,
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
      readerMap: null,
      tickingClock: null,
      foreshadowing: [],
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

  it('includes readerMap (null when absent) and survives an arc with only a reader map', () => {
    expect(sanitizeArc({ logline: 'x' }).readerMap).toBe(null);
    const arc = sanitizeArc({ readerMap: { hooks: [{ label: 'Who is the masked figure?' }] } });
    expect(arc).not.toBe(null);
    expect(arc.logline).toBe('');
    expect(arc.readerMap.hooks).toHaveLength(1);
    // An empty reader map alone is NOT identifying content.
    expect(sanitizeArc({ readerMap: { hooks: [], payoffs: [], beats: [], cliffhangers: [] } })).toBe(null);
  });

  it('includes tickingClock (null when absent) and survives an arc with only an enabled clock', () => {
    expect(sanitizeArc({ logline: 'x' }).tickingClock).toBe(null);
    const arc = sanitizeArc({ tickingClock: { enabled: true, label: 'The storm lands' } });
    expect(arc).not.toBe(null);
    expect(arc.logline).toBe('');
    expect(arc.tickingClock.enabled).toBe(true);
    expect(arc.tickingClock.label).toBe('The storm lands');
    // A disabled, content-free clock is NOT identifying content.
    expect(sanitizeArc({ tickingClock: { enabled: false } })).toBe(null);
  });
});

describe('storyArc — sanitizeTickingClock', () => {
  it('returns null for non-objects and content-free disabled clocks', () => {
    expect(sanitizeTickingClock(null)).toBe(null);
    expect(sanitizeTickingClock('x')).toBe(null);
    expect(sanitizeTickingClock({})).toBe(null);
    expect(sanitizeTickingClock({ enabled: false, label: '', stakes: '' })).toBe(null);
  });

  it('keeps an enabled clock even when otherwise blank', () => {
    const c = sanitizeTickingClock({ enabled: true });
    expect(c).not.toBe(null);
    expect(c.enabled).toBe(true);
    expect(c.kind).toBe('custom');
    expect(c.label).toBe('');
    expect(c.plantedAtArcPosition).toBe(null);
    expect(c.reminders).toEqual([]);
  });

  it('keeps a disabled-but-authored clock (label is identifying content)', () => {
    const c = sanitizeTickingClock({ enabled: false, label: 'Drafted countdown' });
    expect(c).not.toBe(null);
    expect(c.enabled).toBe(false);
    expect(c.label).toBe('Drafted countdown');
  });

  it('round-trips fields, defaults unknown kind to custom, and clamps positions', () => {
    const c = sanitizeTickingClock({
      enabled: true,
      label: 'The prophecy hour',
      kind: 'not-a-kind',
      plantedAtArcPosition: -5,
      dueAtArcPosition: 99999,
      stakes: 'The seal breaks.',
      reminders: [{ atIssue: 3, note: 'omen' }, { note: '' }],
    });
    expect(c.kind).toBe('custom');
    expect(c.plantedAtArcPosition).toBe(0);
    expect(c.dueAtArcPosition).toBe(TICKING_CLOCK_LIMITS.ARC_POSITION_MAX);
    expect(c.stakes).toBe('The seal breaks.');
    // The empty reminder (no note, no issue) is dropped; the valid one keeps a minted id.
    expect(c.reminders).toHaveLength(1);
    expect(c.reminders[0].atIssue).toBe(3);
    expect(c.reminders[0].id).toMatch(/^rm-/);
  });

  it('preserves a known kind and caps the reminders list', () => {
    expect(sanitizeTickingClock({ enabled: true, kind: 'deadline' }).kind).toBe('deadline');
    const many = Array.from({ length: TICKING_CLOCK_LIMITS.REMINDERS_MAX + 5 }, (_, i) => ({ note: `r${i}` }));
    expect(sanitizeTickingClock({ enabled: true, reminders: many }).reminders)
      .toHaveLength(TICKING_CLOCK_LIMITS.REMINDERS_MAX);
  });

  it('exposes a non-empty kind vocabulary', () => {
    expect(TICKING_CLOCK_KINDS).toContain('deadline');
    expect(TICKING_CLOCK_KINDS).toContain('custom');
  });
});

describe('storyArc — renderTickingClock', () => {
  it('returns null when absent or disabled', () => {
    expect(renderTickingClock(null)).toBe(null);
    expect(renderTickingClock({ enabled: false, label: 'x' })).toBe(null);
  });

  it('renders a guidance line with label, stakes, span, and reminders when enabled', () => {
    const text = renderTickingClock({
      enabled: true,
      label: 'The storm makes landfall',
      kind: 'event',
      plantedAtArcPosition: 1,
      dueAtArcPosition: 8,
      stakes: 'The town floods.',
      reminders: [{ atIssue: 4, note: 'barometer drops' }],
    });
    expect(text).toContain('The storm makes landfall');
    expect(text).toContain('event');
    expect(text).toContain('The town floods.');
    expect(text).toContain('arc position 1');
    expect(text).toContain('arc position 8');
    expect(text).toContain('barometer drops');
  });
});

describe('storyArc — sanitizeReaderMap', () => {
  it('returns null for non-objects and empty maps', () => {
    expect(sanitizeReaderMap(null)).toBe(null);
    expect(sanitizeReaderMap('x')).toBe(null);
    expect(sanitizeReaderMap({})).toBe(null);
    expect(sanitizeReaderMap({ hooks: [], payoffs: [], beats: [], cliffhangers: [] })).toBe(null);
  });

  it('round-trips hooks/payoffs/beats/cliffhangers with minted ids', () => {
    const map = sanitizeReaderMap({
      hooks: [{ label: 'Why did the city fall?', atArcPosition: 0, note: 'opening mystery' }],
      payoffs: [{ label: 'The fall was an inside job', atArcPosition: 5 }],
      beats: [{ kind: 'reveal', atArcPosition: 3, intensity: 0.8, note: 'midpoint twist' }],
      cliffhangers: [{ atIssueBoundary: 1, note: 'the door opens' }],
    });
    expect(map.status).toBe('draft');
    expect(map.hooks[0].id).toMatch(/^rm-/);
    expect(map.payoffs[0].atArcPosition).toBe(5);
    expect(map.payoffs[0].resolvesHookId).toBe(null);
    expect(map.beats[0].kind).toBe('reveal');
    expect(map.cliffhangers[0].atIssueBoundary).toBe(1);
  });

  it('drops beats with an unknown kind and clamps intensity to [0,1]', () => {
    const map = sanitizeReaderMap({
      beats: [
        { kind: 'bogus', note: 'dropped' },
        { kind: 'emotional', intensity: 5, note: 'over' },
        { kind: 'hook', intensity: -2, note: 'under' },
        { kind: 'payoff', note: 'no intensity' },
      ],
    });
    expect(map.beats).toHaveLength(3);
    expect(map.beats.find((b) => b.note === 'over').intensity).toBe(1);
    expect(map.beats.find((b) => b.note === 'under').intensity).toBe(0);
    expect(map.beats.find((b) => b.note === 'no intensity').intensity).toBe(null);
  });

  it('preserves valid status and falls back to draft otherwise', () => {
    expect(sanitizeReaderMap({ hooks: [{ label: 'x' }], status: 'verified' }).status).toBe('verified');
    expect(sanitizeReaderMap({ hooks: [{ label: 'x' }], status: 'bogus' }).status).toBe('draft');
  });

  it('caps each list at its limit', () => {
    const manyHooks = Array.from({ length: READER_MAP_LIMITS.HOOKS_MAX + 10 }, (_, i) => ({ label: `h${i}` }));
    expect(sanitizeReaderMap({ hooks: manyHooks }).hooks).toHaveLength(READER_MAP_LIMITS.HOOKS_MAX);
  });

  it('keeps resolvesHookId only when it is an rm- id', () => {
    const ok = sanitizeReaderMap({ payoffs: [{ label: 'p', resolvesHookId: 'rm-abc' }] });
    expect(ok.payoffs[0].resolvesHookId).toBe('rm-abc');
    const bad = sanitizeReaderMap({ payoffs: [{ label: 'p', resolvesHookId: 'hook-1' }] });
    expect(bad.payoffs[0].resolvesHookId).toBe(null);
  });

  it('exposes a non-empty beat-kind vocabulary', () => {
    expect(READER_MAP_BEAT_KINDS).toContain('hook');
    expect(READER_MAP_BEAT_KINDS).toContain('cliffhanger');
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

  it('keeps a full multi-episode synopsis (cap is wide enough to not clip mid-sentence)', () => {
    // A 4000-char cap clipped a real season synopsis mid-word, and the
    // arc-verify→resolve loop then re-flagged the truncation forever (never
    // converged). The cap matches the arc-level SUMMARY_MAX (8000) so a full
    // season synopsis is stored intact. Guard the 5000-char case the old cap broke.
    expect(ARC_LIMITS.SEASON_SYNOPSIS_MAX).toBeGreaterThanOrEqual(8000);
    const long = `${'A complete sentence about the season. '.repeat(130)}`; // ~5000 chars
    expect(long.length).toBeGreaterThan(4000);
    expect(long.length).toBeLessThanOrEqual(ARC_LIMITS.SEASON_SYNOPSIS_MAX);
    const s = sanitizeSeason({ title: 'x', synopsis: long });
    expect(s.synopsis).toBe(long.trim()); // not clipped
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

  it('deduplicates by id (last write wins) and warns on collision', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = sanitizeSeasonList([
      { id: 'sea-dup', title: 'first', number: 1 },
      { id: 'sea-dup', title: 'second', number: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('second');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).toContain('sea-dup');
    expect(msg).toContain('duplicate');
    warnSpy.mockRestore();
  });

  it('does not warn when ids are unique', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sanitizeSeasonList([
      { id: 'sea-a', title: 'A', number: 1 },
      { id: 'sea-b', title: 'B', number: 2 },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reports every duplicate id when multiple ids collide', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sanitizeSeasonList([
      { id: 'sea-a', title: 'A1', number: 1 },
      { id: 'sea-a', title: 'A2', number: 1 },
      { id: 'sea-b', title: 'B1', number: 2 },
      { id: 'sea-b', title: 'B2', number: 2 },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).toContain('sea-a');
    expect(msg).toContain('sea-b');
    expect(msg).toContain('2 duplicate');
    expect(msg).toContain('2 colliding');
    warnSpy.mockRestore();
  });

  it('does not repeat the same id in the warning when one id collides 3+ times', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sanitizeSeasonList([
      { id: 'sea-a', title: 'A1', number: 1 },
      { id: 'sea-a', title: 'A2', number: 1 },
      { id: 'sea-a', title: 'A3', number: 1 },
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0];
    const matches = msg.match(/sea-a/g) || [];
    expect(matches).toHaveLength(1);
    expect(msg).toContain('2 duplicate');
    expect(msg).toContain('1 colliding');
    warnSpy.mockRestore();
  });

  it('caps at SEASONS_PER_SERIES_MAX', () => {
    const many = Array.from({ length: ARC_LIMITS.SEASONS_PER_SERIES_MAX + 5 }, (_, i) => ({ title: `s${i}`, number: i + 1 }));
    expect(sanitizeSeasonList(many)).toHaveLength(ARC_LIMITS.SEASONS_PER_SERIES_MAX);
  });

  it('warns about post-cap duplicate ids without overwriting the surviving entry', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filler = Array.from(
      { length: ARC_LIMITS.SEASONS_PER_SERIES_MAX },
      (_, i) => ({ id: `sea-fill-${i}`, title: `f${i}`, number: i + 1 }),
    );
    const out = sanitizeSeasonList([
      ...filler,
      { id: 'sea-fill-0', title: 'should-not-overwrite-past-cap', number: 1 },
    ]);
    expect(out).toHaveLength(ARC_LIMITS.SEASONS_PER_SERIES_MAX);
    // Past-cap duplicates surface via the warning but do NOT LWW-overwrite —
    // preserves the historical first-wins-past-cap behavior so adding the
    // detector is purely additive.
    const surviving = out.find((s) => s.id === 'sea-fill-0');
    expect(surviving.title).toBe('f0');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('sea-fill-0');
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

describe('storyArc — sanitizeForeshadowing (#2172)', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeForeshadowing(null)).toEqual([]);
    expect(sanitizeForeshadowing(undefined)).toEqual([]);
    expect(sanitizeForeshadowing('x')).toEqual([]);
    expect(sanitizeForeshadowing({})).toEqual([]);
  });

  it('drops entries with no identifying content', () => {
    expect(sanitizeForeshadowingEntry(null)).toBe(null);
    expect(sanitizeForeshadowingEntry({})).toBe(null);
    expect(sanitizeForeshadowingEntry({ label: '   ' })).toBe(null);
    expect(sanitizeForeshadowing([{}, { note: '' }])).toEqual([]);
  });

  it('mints an fs- id, clamps positions, dedupes+sorts reinforce issues', () => {
    const [entry] = sanitizeForeshadowing([
      { label: 'The locked room', plantIssue: 1, reinforceIssues: [5, 3, 3, -2], payoffIssue: 6, note: 'the room opens' },
    ]);
    expect(entry.id).toMatch(/^fs-/);
    expect(entry.label).toBe('The locked room');
    expect(entry.plantIssue).toBe(1);
    expect(entry.payoffIssue).toBe(6);
    // -2 clamps to 0; duplicate 3 collapses; sorted ascending.
    expect(entry.reinforceIssues).toEqual([0, 3, 5]);
  });

  it('flags distanceOk true when payoff is >= MIN distance after plant, false when too close, null when unknown', () => {
    expect(sanitizeForeshadowingEntry({ label: 'a', plantIssue: 1, payoffIssue: 1 + FORESHADOW_LIMITS.MIN_PLANT_PAYOFF_DISTANCE }).distanceOk).toBe(true);
    expect(sanitizeForeshadowingEntry({ label: 'a', plantIssue: 1, payoffIssue: 2 }).distanceOk).toBe(false);
    // A too-close entry is kept (not dropped), just flagged.
    expect(sanitizeForeshadowingEntry({ label: 'a', plantIssue: 1, payoffIssue: 2 })).not.toBe(null);
    // Unknown span (one end missing) → null, not a misleading false.
    expect(sanitizeForeshadowingEntry({ label: 'a', plantIssue: 1 }).distanceOk).toBe(null);
  });

  it('caps the ledger at ENTRIES_MAX', () => {
    const many = Array.from({ length: FORESHADOW_LIMITS.ENTRIES_MAX + 5 }, (_, i) => ({ label: `seed ${i}`, plantIssue: 1 }));
    expect(sanitizeForeshadowing(many)).toHaveLength(FORESHADOW_LIMITS.ENTRIES_MAX);
  });

  it('sanitizeArc round-trips the foreshadowing ledger and survives on ledger alone', () => {
    const arc = sanitizeArc({ foreshadowing: [{ label: 'Mara’s limp', plantIssue: 2, payoffIssue: 8 }] });
    expect(arc).not.toBe(null);
    expect(arc.foreshadowing).toHaveLength(1);
    expect(arc.foreshadowing[0].label).toBe('Mara’s limp');
    // An arc with no foreshadowing still exposes the field as an array.
    const bare = sanitizeArc({ logline: 'just a logline' });
    expect(bare.foreshadowing).toEqual([]);
  });
});
