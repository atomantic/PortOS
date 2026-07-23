import { describe, it, expect, vi } from 'vitest';
import { buildCollectionActions } from './spriteCollectionActions.js';
import { classifySpriteAsset } from './spriteFacets.js';

// The gating IS the feature here — every acceptance criterion on #2931's
// inline actions is a disabled/absent assertion. Assets are built through the
// real classifier so a facet-grammar change can't silently pass this suite.
const asset = (path) => ({ path, facets: classifySpriteAsset(path) });

const STRIP_EAST = asset('grok/walk-east-abc12345/generated/example-walk-east-strip.png');
const FRAME_EAST = asset('grok/walk-east-abc12345/generated/frames/00-left-contact.png');
const CANDIDATE_EAST = asset('reference/candidates/walk-east-candidate-1.png');

const RUN_EAST = {
  id: 'walk-east-abc12345',
  direction: 'east',
  status: 'candidate',
  stripPreview: { stripPath: 'grok/walk-east-abc12345/generated/example-walk-east-strip.png' },
};

const detailWith = (over = {}) => ({
  record: { id: 'example-walker', kind: 'character' },
  reference: { manifest: { anchors: [{ direction: 'east', status: 'locked' }, { direction: 'west', status: 'pending' }] } },
  walk: { runs: [RUN_EAST], selection: { directions: {} }, walkSet: null },
  ...over,
});

const build = (over = {}, maps = {}) => buildCollectionActions({
  detail: detailWith(over),
  generateWalk: vi.fn(),
  generateAnchor: vi.fn(),
  onRequestTrim: vi.fn(),
  ...maps,
});

describe('regenerateFor — walk outputs', () => {
  it('enables regenerate on a strip whose anchor is locked and nothing is in flight', () => {
    const r = build().regenerateFor(STRIP_EAST);
    expect(r).toMatchObject({ kind: 'walk', disabled: false, pending: false });
  });

  it('covers every walk output role, not just the strip', () => {
    expect(build().regenerateFor(FRAME_EAST)).toMatchObject({ kind: 'walk', disabled: false });
  });

  it('disables while a render for that direction is in flight', () => {
    const r = build({}, { walkPending: { east: 'job-1' } }).regenerateFor(STRIP_EAST);
    expect(r).toMatchObject({ disabled: true, pending: true });
  });

  it('treats the submitting sentinel as in flight — that is the double-click guard', () => {
    expect(build({}, { walkPending: { east: 'submitting' } }).regenerateFor(STRIP_EAST).disabled).toBe(true);
  });

  it('disables once the walk set is finalized', () => {
    const r = build({ walk: { runs: [RUN_EAST], selection: { directions: {} }, walkSet: { frozen: true } } })
      .regenerateFor(STRIP_EAST);
    expect(r.disabled).toBe(true);
    expect(r.title).toMatch(/finalized/);
  });

  it('disables for a direction that is already approved', () => {
    const r = build({ walk: { runs: [RUN_EAST], selection: { directions: { east: { status: 'approved' } } }, walkSet: null } })
      .regenerateFor(STRIP_EAST);
    expect(r.disabled).toBe(true);
    expect(r.title).toMatch(/already approved/);
  });

  it('disables while the direction anchor is still unlocked', () => {
    const r = build({ reference: { manifest: { anchors: [{ direction: 'east', status: 'pending' }] } } })
      .regenerateFor(STRIP_EAST);
    expect(r.disabled).toBe(true);
    expect(r.title).toMatch(/Lock this direction/);
  });

  it('fires the walk generator with the asset own direction', () => {
    const generateWalk = vi.fn();
    buildCollectionActions({
      detail: detailWith(), generateWalk, generateAnchor: vi.fn(), onRequestTrim: vi.fn(),
    }).regenerateFor(STRIP_EAST).onClick();
    expect(generateWalk).toHaveBeenCalledWith('east');
  });
});

describe('regenerateFor — reference anchors', () => {
  it('offers an anchor re-roll for an unlocked candidate', () => {
    const r = build({ reference: { manifest: { anchors: [{ direction: 'east', status: 'pending' }] } } })
      .regenerateFor(CANDIDATE_EAST);
    expect(r).toMatchObject({ kind: 'reference', disabled: false });
    r.onClick();
  });

  it('disables the re-roll once the anchor is locked — locks are irreversible', () => {
    expect(build().regenerateFor(CANDIDATE_EAST).disabled).toBe(true);
  });

  it('disables while an anchor render is in flight', () => {
    const r = build(
      { reference: { manifest: { anchors: [{ direction: 'east', status: 'pending' }] } } },
      { referencePending: { east: 'job-2' } },
    ).regenerateFor(CANDIDATE_EAST);
    expect(r).toMatchObject({ disabled: true, pending: true });
  });

  it('never offers a re-roll for the main reference — it needs a prompt or upload', () => {
    const main = asset('reference/candidates/walk-south-candidate-1.png');
    const actions = buildCollectionActions({
      detail: detailWith({ reference: { manifest: { anchors: [{ direction: 'south', status: 'pending' }] } } }),
      generateWalk: vi.fn(), generateAnchor: vi.fn(), onRequestTrim: vi.fn(),
    });
    expect(actions.regenerateFor(main)).toBeNull();
  });

  it('never offers a re-roll for a LOCKED reference file (not a candidate)', () => {
    expect(build().regenerateFor(asset('reference/example-walk-east-v1.png'))).toBeNull();
  });
});

describe('regenerateFor — backend gate (#2938)', () => {
  const unlockedEast = { reference: { manifest: { anchors: [{ direction: 'east', status: 'pending' }] } } };

  it('disables the anchor re-roll when no image backend is configured', () => {
    const r = build(unlockedEast, { hasBackend: false }).regenerateFor(CANDIDATE_EAST);
    expect(r).toMatchObject({ kind: 'reference', disabled: true });
    expect(r.title).toMatch(/No image backend/);
  });

  it('keeps the re-roll enabled when a backend is available (default) ', () => {
    expect(build(unlockedEast).regenerateFor(CANDIDATE_EAST).disabled).toBe(false);
  });

  it('threads the workflow-selected backend into the anchor re-roll', () => {
    const generateAnchor = vi.fn();
    buildCollectionActions({
      detail: detailWith(unlockedEast),
      generateWalk: vi.fn(), generateAnchor, onRequestTrim: vi.fn(),
      mode: 'grok',
    }).regenerateFor(CANDIDATE_EAST).onClick();
    expect(generateAnchor).toHaveBeenCalledWith('east', 'grok');
  });
});

describe('regenerateFor — non-actionable assets', () => {
  it.each([
    ['a manifest', 'grok/walk-east-abc12345/generated/example-walk-east-manifest.json'],
    ['a review sheet', 'grok/walk-east-abc12345/generated/review/example-walk-east-contrast-review.png'],
    ['an uploaded design image', 'reference/uploads/design.png'],
    ['a published atlas', 'runtime/v3/example-v3.png'],
  ])('returns null for %s', (_label, path) => {
    expect(build().regenerateFor(asset(path))).toBeNull();
  });

  it('returns null for a direction the record has no anchor for', () => {
    expect(build({ reference: { manifest: { anchors: [] } } }).regenerateFor(STRIP_EAST)).toBeNull();
  });

  it('tolerates a row with no facets', () => {
    expect(build().regenerateFor({ path: 'x.png' })).toBeNull();
    expect(build().trimFor(undefined)).toBeNull();
  });
});

describe('trimFor', () => {
  it('offers the trimmer for a run that packed a strip', () => {
    const onRequestTrim = vi.fn();
    const actions = buildCollectionActions({
      detail: detailWith(), generateWalk: vi.fn(), generateAnchor: vi.fn(), onRequestTrim,
    });
    actions.trimFor(STRIP_EAST).onClick();
    expect(onRequestTrim).toHaveBeenCalledWith('walk-east-abc12345');
  });

  it('stays available on an approved direction and a finalized walk set', () => {
    // Trims are non-destructive derived artifacts — the server only needs a
    // packaged manifest, so freezing the walk set must not hide the trimmer.
    const actions = build({
      walk: {
        runs: [{ ...RUN_EAST, status: 'approved' }],
        selection: { directions: { east: { status: 'approved' } } },
        walkSet: { frozen: true },
      },
    });
    expect(actions.trimFor(STRIP_EAST)).not.toBeNull();
  });

  it('is withheld for a run that never packed a strip — the endpoint would 409', () => {
    const actions = build({ walk: { runs: [{ id: 'walk-east-abc12345', direction: 'east', status: 'error' }], selection: { directions: {} }, walkSet: null } });
    expect(actions.trimFor(STRIP_EAST)).toBeNull();
  });

  it('is withheld for an asset outside a run', () => {
    expect(build().trimFor(CANDIDATE_EAST)).toBeNull();
    expect(build().trimFor(asset('runtime/v3/example-v3.png'))).toBeNull();
  });
});
