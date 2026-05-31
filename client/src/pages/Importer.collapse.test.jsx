import { describe, it, expect } from 'vitest';
import { collapseToSingleVolume } from './Importer.jsx';

describe('collapseToSingleVolume', () => {
  const seasonsPreview = [
    { number: 1, title: 'The Miracle Man', logline: 'Beanstalk begins', synopsis: 'syn1' },
    { number: 2, title: 'Magic Beans', logline: 'The climb', synopsis: 'syn2' },
    { number: 3, title: 'Sins of the Fathers', logline: 'The fall', synopsis: 'syn3' },
    { number: 4, title: 'The Curse Lifted', logline: 'The end', synopsis: 'syn4' },
  ];
  const issues = [
    { title: 'Issue 1', arcPosition: 1, proseExcerpt: 'PAGE 1...' },
    { title: 'Issue 2', arcPosition: 2, proseExcerpt: 'PAGE 23...' },
    { title: 'Issue 3', arcPosition: 3, proseExcerpt: 'PAGE 45...' },
  ];

  it('produces exactly one volume sized to the issue count', () => {
    const out = collapseToSingleVolume({ seasonsPreview, issues, seriesName: 'Giant', arc: { logline: 'LG', summary: 'SM' } });
    expect(out.seasons).toHaveLength(1);
    expect(out.seasons[0]).toMatchObject({ number: 1, title: 'Giant', logline: 'LG', synopsis: 'SM', episodeCountTarget: 3 });
  });

  it('pins every issue to volume 1 and zips the season descriptions into synopses', () => {
    const out = collapseToSingleVolume({ seasonsPreview, issues, seriesName: 'Giant', arc: {} });
    expect(out.issues).toHaveLength(3);
    expect(out.issues.every((i) => i.seasonNumber === 1)).toBe(true);
    // Extra 4th season (no matching issue) falls off — that's expected.
    expect(out.issues[0].synopsis).toContain('Beanstalk begins');
    expect(out.issues[0].synopsis).toContain('syn1');
    expect(out.issues[2].synopsis).toContain('The fall');
  });

  it('keeps an issue synopsis the user already authored', () => {
    const withSyn = [{ title: 'Issue 1', arcPosition: 1, synopsis: 'user wrote this' }];
    const out = collapseToSingleVolume({ seasonsPreview, issues: withSyn, seriesName: 'Giant', arc: {} });
    expect(out.issues[0].synopsis).toBe('user wrote this');
  });

  it('falls back to the first season title when there is no series name', () => {
    const out = collapseToSingleVolume({ seasonsPreview, issues, seriesName: '', arc: {} });
    expect(out.seasons[0].title).toBe('The Miracle Man');
  });

  it('clamps a long zipped synopsis to the 4000-char cap', () => {
    const longSeason = [{ number: 1, title: 'X', logline: 'a'.repeat(3000), synopsis: 'b'.repeat(3000) }];
    const out = collapseToSingleVolume({ seasonsPreview: longSeason, issues: [{ title: 'I1', arcPosition: 1 }], seriesName: 'S', arc: {} });
    expect(out.issues[0].synopsis.length).toBe(4000);
  });
});
