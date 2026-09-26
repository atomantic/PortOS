import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveUniverseMock = vi.fn();
const resolveBoardMock = vi.fn();
vi.mock('../creativeStyleSources.js', () => ({
  resolveUniverseStyleSource: (...a) => resolveUniverseMock(...a),
  resolveMoodBoardStyleSource: (...a) => resolveBoardMock(...a),
}));

const { resolveCommissionStyleSource, composeCommissionStyleSpec, COMMISSION_STYLE_REFERENCE_IMAGES_MAX } = await import('./styleSource.js');
const { MAX_STYLE_SOURCE_LEN } = await import('./directive.js');
const { COMMISSION_STYLE_SPEC_MAX } = await import('../../lib/creativeBriefLimits.js');

const notFound = () => Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
const universe = (over = {}) => ({
  name: 'Example Universe',
  embrace: ['ink wash', 'muted teal'],
  avoid: ['neon'],
  styleNotes: 'quiet, patient framing',
  styleReferences: [],
  moodBoardId: 'linked-board',
  images: [{ label: 'Harbor study', origin: 'universe', path: '/abs/a.png', url: '/data/image-refs/a.png' }],
  ...over,
});
const board = { board: { name: 'Example Board', items: [{ caption: 'fog over water' }] }, images: [{ label: 'Pin', origin: 'mood-board', path: '/abs/b.png', url: '/data/images/b.png' }] };
const commission = (constraints) => ({ brief: { intent: 'x', constraints } });

beforeEach(() => {
  resolveUniverseMock.mockReset().mockResolvedValue(universe());
  resolveBoardMock.mockReset().mockResolvedValue(board);
});

describe('resolveCommissionStyleSource', () => {
  it('returns null when no style source is configured', async () => {
    expect(await resolveCommissionStyleSource(commission({}))).toBeNull();
    expect(resolveUniverseMock).not.toHaveBeenCalled();
  });

  it('follows the universe’s linked board and renders tags, notes, the board, and served image paths', async () => {
    const source = await resolveCommissionStyleSource(commission({ universeId: 'u1' }));
    expect(resolveBoardMock).toHaveBeenCalledWith('linked-board', { imageSlots: COMMISSION_STYLE_REFERENCE_IMAGES_MAX - 1 });
    expect(source).toMatchObject({ universeId: 'u1', universeName: 'Example Universe', moodBoardId: 'linked-board', moodBoardName: 'Example Board' });
    expect(source.text).toContain('Visual style to embrace: ink wash, muted teal');
    expect(source.text).toContain('Visual style to avoid: neon');
    expect(source.text).toContain('quiet, patient framing');
    expect(source.text).toContain('fog over water');
    expect(source.text).toContain('/data/image-refs/a.png');
    expect(source.text).toContain('/data/images/b.png');
    // Absolute machine paths never reach the prompt / synced project record.
    expect(source.text).not.toContain('/abs/');
  });

  it("honors '' as no board and an explicit id over the universe's link", async () => {
    const none = await resolveCommissionStyleSource(commission({ universeId: 'u1', moodBoardId: '' }));
    expect(resolveBoardMock).not.toHaveBeenCalled();
    expect(none.moodBoardId).toBeNull();

    await resolveCommissionStyleSource(commission({ universeId: 'u1', moodBoardId: 'b2' }));
    expect(resolveBoardMock).toHaveBeenCalledWith('b2', expect.any(Object));
  });

  it('works from a mood board alone', async () => {
    const source = await resolveCommissionStyleSource(commission({ moodBoardId: 'b2' }));
    expect(resolveUniverseMock).not.toHaveBeenCalled();
    expect(source).toMatchObject({ universeId: null, moodBoardId: 'b2' });
    expect(source.text).toContain('Example Board');
  });

  it('skips a deleted universe or board instead of failing the fire, but propagates outages', async () => {
    resolveUniverseMock.mockRejectedValueOnce(notFound());
    const source = await resolveCommissionStyleSource(commission({ universeId: 'gone', moodBoardId: 'b2' }));
    expect(source).toMatchObject({ universeId: null, moodBoardId: 'b2' });

    resolveUniverseMock.mockRejectedValueOnce(notFound());
    resolveBoardMock.mockRejectedValueOnce(notFound());
    expect(await resolveCommissionStyleSource(commission({ universeId: 'gone', moodBoardId: 'gone' })))
      .toMatchObject({ universeId: null, moodBoardId: null, universeMissing: true, text: '' });

    resolveUniverseMock.mockRejectedValueOnce(new Error('connection refused'));
    await expect(resolveCommissionStyleSource(commission({ universeId: 'u1' }))).rejects.toThrow('connection refused');
  });

  it('bounds the rendered base while keeping the image list', async () => {
    resolveUniverseMock.mockResolvedValue(universe({ styleNotes: 'z'.repeat(10_000) }));
    const source = await resolveCommissionStyleSource(commission({ universeId: 'u1' }));
    expect(source.text.length).toBeLessThanOrEqual(MAX_STYLE_SOURCE_LEN);
    expect(source.text).toContain('/data/images/b.png');
  });
});

describe('composeCommissionStyleSpec', () => {
  it('layers the commission’s own notes on top of the base and never cuts them for it', () => {
    expect(composeCommissionStyleSpec('flat color', null)).toBe('flat color');
    const spec = composeCommissionStyleSpec('flat color', { text: 'BASE' });
    expect(spec.indexOf('BASE')).toBeLessThan(spec.indexOf('flat color'));

    const own = 'y'.repeat(COMMISSION_STYLE_SPEC_MAX - 100);
    const long = composeCommissionStyleSpec(own, { text: 'b'.repeat(MAX_STYLE_SOURCE_LEN) });
    expect(long.length).toBeLessThanOrEqual(COMMISSION_STYLE_SPEC_MAX);
    expect(long).toContain(own);
  });
});
