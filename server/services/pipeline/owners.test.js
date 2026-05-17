import { describe, it, expect } from 'vitest';
import {
  buildComicPagesOwner, parseComicPagesOwner,
  buildStoryboardsShotOwner, parseStoryboardsShotOwner,
  buildSeasonCoverOwner, parseSeasonCoverOwner,
} from './owners.js';

describe('pipeline owner strings', () => {
  it('round-trips a cover proof owner', () => {
    const owner = buildComicPagesOwner({ issueId: 'iss-abc', target: 'cover', variant: 'proof' });
    expect(owner).toBe('pipeline:iss-abc:comicPages:cover:proof');
    expect(parseComicPagesOwner(owner)).toEqual({ issueId: 'iss-abc', target: 'cover', variant: 'proof' });
  });

  it('round-trips a cover final owner', () => {
    const owner = buildComicPagesOwner({ issueId: 'iss-abc', target: 'cover', variant: 'final' });
    expect(owner).toBe('pipeline:iss-abc:comicPages:cover:final');
    expect(parseComicPagesOwner(owner)).toEqual({ issueId: 'iss-abc', target: 'cover', variant: 'final' });
  });

  it('round-trips backCover owners (proof + final)', () => {
    const proof = buildComicPagesOwner({ issueId: 'iss-abc', target: 'backCover', variant: 'proof' });
    expect(proof).toBe('pipeline:iss-abc:comicPages:backCover:proof');
    expect(parseComicPagesOwner(proof)).toEqual({ issueId: 'iss-abc', target: 'backCover', variant: 'proof' });

    const final = buildComicPagesOwner({ issueId: 'iss-abc', target: 'backCover', variant: 'final' });
    expect(final).toBe('pipeline:iss-abc:comicPages:backCover:final');
    expect(parseComicPagesOwner(final)).toEqual({ issueId: 'iss-abc', target: 'backCover', variant: 'final' });
  });

  it('round-trips a page owner — default variant is proof', () => {
    const owner = buildComicPagesOwner({ issueId: 'iss-xyz', target: 'page', pageIndex: 7 });
    expect(owner).toBe('pipeline:iss-xyz:comicPages:page7:proof');
    expect(parseComicPagesOwner(owner)).toEqual({ issueId: 'iss-xyz', target: 'page', pageIndex: 7, variant: 'proof' });
  });

  it('round-trips a page final owner', () => {
    const owner = buildComicPagesOwner({ issueId: 'iss-xyz', target: 'page', pageIndex: 2, variant: 'final' });
    expect(owner).toBe('pipeline:iss-xyz:comicPages:page2:final');
    expect(parseComicPagesOwner(owner)).toEqual({ issueId: 'iss-xyz', target: 'page', pageIndex: 2, variant: 'final' });
  });

  it('legacy owners without a variant suffix default to proof on parse', () => {
    expect(parseComicPagesOwner('pipeline:iss-old:comicPages:cover'))
      .toEqual({ issueId: 'iss-old', target: 'cover', variant: 'proof' });
    expect(parseComicPagesOwner('pipeline:iss-old:comicPages:page3'))
      .toEqual({ issueId: 'iss-old', target: 'page', pageIndex: 3, variant: 'proof' });
  });

  it('builder throws on unknown target or variant', () => {
    expect(() => buildComicPagesOwner({ issueId: 'iss-1', target: 'panel' })).toThrow();
    expect(() => buildComicPagesOwner({ issueId: 'iss-1', target: 'cover', variant: 'sketch' })).toThrow();
  });

  it('parser returns null for unmatched strings', () => {
    expect(parseComicPagesOwner(null)).toBeNull();
    expect(parseComicPagesOwner('')).toBeNull();
    expect(parseComicPagesOwner('not-a-pipeline-owner')).toBeNull();
    expect(parseComicPagesOwner('pipeline:iss:storyboards:scene0')).toBeNull();
    expect(parseComicPagesOwner('pipeline:iss:comicPages:pageNaN')).toBeNull();
    expect(parseComicPagesOwner('pipeline:iss:comicPages:cover:sketch')).toBeNull();
  });

  it('round-trips a storyboards shot owner', () => {
    const owner = buildStoryboardsShotOwner({ issueId: 'iss-789', sceneIndex: 2, shotIndex: 5 });
    expect(owner).toBe('pipeline:iss-789:storyboards:scene2:shot5');
    expect(parseStoryboardsShotOwner(owner)).toEqual({ issueId: 'iss-789', sceneIndex: 2, shotIndex: 5 });
  });

  it('shot parser rejects non-shot owners and malformed indices', () => {
    expect(parseStoryboardsShotOwner(null)).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:comicPages:cover')).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:storyboards:scene0')).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:storyboards:scene1:shotNaN')).toBeNull();
  });

  it('comic parser does not match shot owners and vice versa', () => {
    expect(parseComicPagesOwner('pipeline:iss:storyboards:scene1:shot2')).toBeNull();
    expect(parseStoryboardsShotOwner('pipeline:iss:comicPages:page3')).toBeNull();
  });

  it('round-trips season-cover owners across both variants and both targets', () => {
    for (const target of ['cover', 'backCover']) {
      for (const variant of ['proof', 'final']) {
        const owner = buildSeasonCoverOwner({
          seriesId: 'ser-foo', seasonId: 'sea-bar', target, variant,
        });
        expect(owner).toBe(`pipeline:season:ser-foo:sea-bar:${target}:${variant}`);
        expect(parseSeasonCoverOwner(owner)).toEqual({
          seriesId: 'ser-foo', seasonId: 'sea-bar', target, variant,
        });
      }
    }
  });

  it('season-cover builder rejects unknown target / variant', () => {
    expect(() => buildSeasonCoverOwner({
      seriesId: 's', seasonId: 'sea', target: 'panel', variant: 'proof',
    })).toThrow();
    expect(() => buildSeasonCoverOwner({
      seriesId: 's', seasonId: 'sea', target: 'cover', variant: 'sketch',
    })).toThrow();
  });

  it('season-cover and issue-cover owners do not match each other', () => {
    const issueCover = 'pipeline:iss-abc:comicPages:cover:proof';
    const seasonCover = 'pipeline:season:ser-foo:sea-bar:cover:proof';
    expect(parseSeasonCoverOwner(issueCover)).toBeNull();
    expect(parseComicPagesOwner(seasonCover)).toBeNull();
  });

  it('season-cover parser rejects malformed strings', () => {
    expect(parseSeasonCoverOwner(null)).toBeNull();
    expect(parseSeasonCoverOwner('')).toBeNull();
    expect(parseSeasonCoverOwner('pipeline:season:s:sea:cover')).toBeNull();      // missing variant
    expect(parseSeasonCoverOwner('pipeline:season:s:sea:panel:proof')).toBeNull(); // bad target
    expect(parseSeasonCoverOwner('pipeline:s:sea:cover:proof')).toBeNull();        // missing 'season:'
  });
});
