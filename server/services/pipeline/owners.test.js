import { describe, it, expect } from 'vitest';
import {
  buildComicPagesOwner, parseComicPagesOwner,
  buildStoryboardsShotOwner, parseStoryboardsShotOwner,
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
});
