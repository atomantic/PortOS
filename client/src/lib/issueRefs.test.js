import { describe, it, expect } from 'vitest';
import { agentIssueLinkifier, splitIssueRefs } from './issueRefs';

const BASE = 'https://github.com/atomantic/PortOS/issues';

// Only the segments the renderer turns into anchors.
const refs = (text, base = BASE) => splitIssueRefs(text, base).filter(p => typeof p !== 'string');

describe('splitIssueRefs', () => {
  it('links every reference and keeps the surrounding prose intact', () => {
    expect(splitIssueRefs('Closes #7640, refs #22.', BASE)).toEqual([
      'Closes ',
      { ref: '#7640', url: `${BASE}/7640` },
      ', refs ',
      { ref: '#22', url: `${BASE}/22` },
      '.',
    ]);
  });

  it('appends to a GitLab base exactly as the server shaped it', () => {
    const gitlab = 'https://gitlab.example.com/group/sub/proj/-/issues';
    expect(refs('see #12', gitlab)).toEqual([
      { ref: '#12', url: `${gitlab}/12` },
    ]);
  });

  // The pattern's job is to DECLINE: a wrong link gets followed, a missing one
  // is merely read. Each row is a distinct false-positive class.
  it.each([
    ['a version suffix', 'shipped in v1.2.3#4'],
    ['a repeated hash', 'heading ##2 here'],
    ['an HTML entity', 'literal &#123; brace'],
    ['a source-line anchor', 'server/lib/foo.js#12 is the spot'],
    ['a URL fragment', 'https://github.com/a/b/pull/7#22 was merged'],
    ['a non-numeric anchor', 'README.md#L12 and #Lx'],
    ['a trailing word character', '#12abc'],
    ['a six-digit hex colour', 'use color: #336699 for the border'],
    ['a compact CSS colour', 'span{color:#336}'],
    ['a zero-led hex colour', 'border 1px solid #000 here'],
    // The stamped base names one repository and cannot be retargeted, so the
    // honest outcome is plain text — never the same number in the wrong repo.
    ['a cross-repo reference', 'see atomantic/slashdo#12'],
  ])('leaves %s alone', (_label, text) => {
    expect(refs(text)).toEqual([]);
  });

  it('returns the input untouched when there is no tracker, or nothing to link', () => {
    expect(splitIssueRefs('Closes #7640', null)).toEqual(['Closes #7640']);
    expect(splitIssueRefs('no references here', BASE)).toEqual(['no references here']);
  });

  it('tolerates a trailing slash on the stamped base', () => {
    expect(refs('#7', `${BASE}/`)).toEqual([{ ref: '#7', url: `${BASE}/7` }]);
  });
});

describe('agentIssueLinkifier', () => {
  it('resolves against the run record, and is null for a run predating the stamp', () => {
    const resolve = agentIssueLinkifier({ metadata: { repoIssueUrl: BASE } });
    expect(resolve('Closes #7640')).toContainEqual({ ref: '#7640', url: `${BASE}/7640` });
    expect(agentIssueLinkifier({ metadata: {} })).toBeNull();
    expect(agentIssueLinkifier(null)).toBeNull();
  });
});
