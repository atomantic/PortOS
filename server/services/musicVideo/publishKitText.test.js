/**
 * Publishing kit text (#9281): YouTube chapters obey YouTube's own rules
 * (0:00 first, >= 10 s each, >= 3 or none), captions never overlap and stay up
 * long enough to read, and the copy parser clips to each platform's limits.
 */
import { describe, expect, it } from 'vitest';
import { buildChapters, chaptersText, buildSrt, buildPublishCopyPrompt, parsePublishCopy } from './publishKitText.js';

const scene = (startSec, endSec, sectionLabel) => ({ sceneId: `s${startSec}`, startSec, endSec, sectionLabel });
const cue = (text, startSec, endSec) => ({ id: `c${startSec}`, text, startSec, endSec });

const project = {
  name: 'Example Song',
  scenes: [
    scene(0, 1.5, 'Intro'), scene(1.5, 20, 'Verse 1'), scene(20, 29, 'Verse 1'),
    scene(29, 40, 'Pre-Chorus'), scene(40, 43, 'Stop'), scene(43, 72, 'Chorus 1'), scene(72, 90, 'Outro'),
  ],
  lyricCues: [cue('I’m walking in the lab.', 1.9, 5), cue('One more layer', 32, 34), cue('"Hold the line!"', 44, 46)],
};

describe('buildChapters (#9281)', () => {
  it('titles sections by their first sung line, folds short ones, and starts at 0:00', () => {
    const chapters = buildChapters(project);
    expect(chapters.map((c) => c.startSec)).toEqual([0, 29, 43, 72]);
    expect(chapters.map((c) => c.label)).toEqual(['I’m walking in the lab', 'One more layer', 'Hold the line', 'Outro']);
    expect(chaptersText(chapters)).toBe('0:00 I’m walking in the lab\n0:29 One more layer\n0:43 Hold the line\n1:12 Outro');
  });

  it('offers no chapters when the song cannot make three of at least 10 s', () => {
    expect(buildChapters({ scenes: [scene(0, 12, 'A'), scene(12, 25, 'B')] })).toEqual([]);
    expect(buildChapters({})).toEqual([]);
  });
});

describe('buildSrt (#9281)', () => {
  it('keeps each cue on screen long enough to read without overlapping the next', () => {
    const srt = buildSrt({ lyricCues: [cue('one', 1, 1.2), cue('two', 1.5, 4), cue('three', 3.9, 5)] });
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:01,480\none\n\n2\n00:00:01,500 --> 00:00:03,880\ntwo\n\n3\n00:00:03,900 --> 00:00:05,000\nthree\n');
    expect(buildSrt({})).toBeNull();
  });
});

describe('publish copy prompt + parser (#9281)', () => {
  it('states only the facts it was given', () => {
    const withSpend = buildPublishCopyPrompt(project, { notes: 'hummed it in the car', spentUsd: 37.876, links: { youtube: 'https://example.com/v' }, include: { spend: true } });
    expect(withSpend).toContain('Video generation spend: $37.88');
    expect(withSpend).toContain('Full video URL: https://example.com/v');
    expect(withSpend).toContain('hummed it in the car');
    expect(buildPublishCopyPrompt(project, {})).not.toContain('spend:');
  });

  it('leaves out lyrics, spend and hashtags unless the director ticked them', () => {
    const lyricProject = { ...project, name: 'Example Song', lyricCues: [cue('a sung line', 1, 2)] };
    const plain = buildPublishCopyPrompt(lyricProject, { spentUsd: 12 });
    expect(plain).toContain('Song title: Example Song');
    expect(plain).not.toContain('a sung line');
    expect(plain).not.toContain('spend:');
    expect(plain).toContain('no hashtags anywhere');
    expect(plain).toContain('a sentence or two');
    expect(plain).not.toContain('#shorts');
    expect(plain).not.toContain('"tags"');
    const all = buildPublishCopyPrompt(lyricProject, { spentUsd: 12, include: { title: false, lyrics: true, spend: true, hashtags: true }, length: 'full' });
    expect(all).not.toContain('Song title:');
    expect(all).toContain('a sung line');
    expect(all).toContain('#shorts');
    expect(all).toContain('the making-of as a long post');
  });

  it('strips hashtags the model added unasked and leaves everything else as written', () => {
    const description = '# Heading\nA line #tagged here, my #1 take\n  - nested item  \nSee https://example.com/album/#listen';
    const reply = JSON.stringify({ tiktok: { caption: 'Out now #newmusic, link below (#music)\n#a #b\nMade this one slowly. #music #aivideo' }, youtube: { title: 'T', description, tags: ['music'] } });
    const copy = parsePublishCopy(reply, ['tiktok', 'youtube'], { hashtags: false });
    // No stray space before punctuation, no empty brackets, no line left holding only tags.
    expect(copy.tiktok.caption).toBe('Out now, link below\nMade this one slowly.');
    // Numbers, URL fragments, headings, indentation and markdown hard breaks survive.
    expect(copy.youtube.description).toBe('# Heading\nA line here, my #1 take\n  - nested item  \nSee https://example.com/album/#listen');
    // No tags come back, so a redraft keeps the ones the director typed.
    expect(copy.youtube).not.toHaveProperty('tags');
    expect(parsePublishCopy(reply, ['tiktok']).tiktok.caption).toContain('#music');
    // A tags-only line between paragraphs leaves one paragraph break, not two.
    const between = JSON.stringify({ tiktok: { caption: 'Para one\n\n#a #b\n\nPara two' } });
    expect(parsePublishCopy(between, ['tiktok'], { hashtags: false }).tiktok.caption).toBe('Para one\n\nPara two');
  });

  it('clips each field to its platform limit and rejects an empty or non-JSON reply', () => {
    const reply = `\`\`\`json\n${JSON.stringify({ youtube: { title: 'T'.repeat(150), tags: ['a', 'b'] }, x: { hook: 'H'.repeat(400), story: 'long' }, stackerNews: { title: 'S'.repeat(120) } })}\n\`\`\``;
    const copy = parsePublishCopy(reply);
    expect(copy.youtube.title).toHaveLength(100);
    expect(copy.youtube.tags).toEqual(['a', 'b']);
    expect(copy.x.hook).toHaveLength(280);
    expect(copy.stackerNews.title).toHaveLength(80);
    expect(copy.reddit).toEqual({ title: '', body: '' });
    expect(parsePublishCopy('no json here')).toBeNull();
    expect(parsePublishCopy('{"youtube":{}}')).toBeNull();
  });
});
