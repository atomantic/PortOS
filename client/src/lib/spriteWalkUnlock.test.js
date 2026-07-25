import { describe, it, expect } from 'vitest';
import { walkUnlockCopy, WALK_UNLOCK_TOAST } from './spriteWalkUnlock.js';

// The copy is shared by the Walk Cycles header and the Loop Trimmer's lock block
// (#3043) precisely so one server-stamped block can't be described two ways —
// which is why the branches are pinned here rather than only through whichever
// component happens to render them.
describe('walkUnlockCopy', () => {
  it('returns null for an unblocked set so callers offer the ordinary Unlock', () => {
    expect(walkUnlockCopy({ blocked: false, stranded: [], acknowledgeable: false })).toBeNull();
    expect(walkUnlockCopy(null)).toBeNull();
    expect(walkUnlockCopy(undefined)).toBeNull();
  });

  it('offers regeneration, and the consent flag, for a blocked-but-regenerable set', () => {
    const copy = walkUnlockCopy({ blocked: true, stranded: ['east'], acknowledgeable: true });
    expect(copy.acknowledgeNoClips).toBe(true);
    expect(copy.action).toBe('Unlock anyway');
    expect(copy.toast).toBeTruthy();
    // The cost has to be in the TEXT, not a tooltip — a touch user never sees a title.
    expect(copy.text).toMatch(/one new grok render per direction/);
    expect(copy.text).toMatch(/every approval is dropped/);
  });

  it('offers no action, and never the consent flag, when regeneration is out too', () => {
    const copy = walkUnlockCopy({ blocked: true, stranded: ['east'], acknowledgeable: false });
    expect(copy.action).toBeNull();
    expect(copy.acknowledgeNoClips).toBe(false);
    expect(copy.text).toMatch(/nothing to regenerate from either/);
  });

  it('inflects the stranded list, and names the set when there is no per-direction evidence', () => {
    expect(walkUnlockCopy({ blocked: true, stranded: ['east'], acknowledgeable: true }).text)
      .toMatch(/^east was imported .* without its source clip, so it cannot be re-derived/);
    expect(walkUnlockCopy({ blocked: true, stranded: ['east', 'north'], acknowledgeable: true }).text)
      .toMatch(/^east, north were imported .* without their source clips, so they cannot be re-derived/);
    // The evidence-free set-level-import case is blocked with an EMPTY list — it
    // must not render as "" or as a singular direction.
    expect(walkUnlockCopy({ blocked: true, stranded: [], acknowledgeable: true }).text)
      .toMatch(/^This walk set was imported/);
  });

  it('exports the plain-unlock success toast', () => {
    expect(WALK_UNLOCK_TOAST).toMatch(/unlocked/);
  });
});
