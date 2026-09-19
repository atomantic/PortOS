import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRIVATE_UNTRUSTED_CONTENT_SOURCES, UNTRUSTED_CONTENT_SOURCES } from './untrustedContent.js';

// A source the server screens but the panel never lists is screened under the
// shipped defaults FOREVER: `maxInputChars`, the classifier mode and the
// provider pin are all unreachable for it. That is how `stacker-news` could be
// added to the boundary and still be unconfigurable (#7680), so the two lists
// are pinned to each other here rather than by eye. Read as text on purpose —
// a server suite importing a `.jsx` component drags the client's test deps
// into the node environment.
const panelSource = readFileSync(new URL('../../client/src/components/models/UntrustedContentPolicyPanel.jsx', import.meta.url), 'utf8');
const literalArray = (name) => {
  const body = panelSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1];
  expect(body, `${name} is no longer a literal array in the panel`).toBeTruthy();
  return [...body.matchAll(/'([^']+)'/g)].map(([, value]) => value);
};

describe('untrusted-content source parity', () => {
  it('offers every screened source in the policy panel', () => {
    const offered = literalArray('SOURCES');
    expect(offered).toContain('defaults');
    // Every id in the panel is a label/value pair, so filter to the ones the
    // server actually knows rather than asserting on the display strings.
    expect(offered.filter((value) => UNTRUSTED_CONTENT_SOURCES.includes(value)))
      .toEqual(expect.arrayContaining([...UNTRUSTED_CONTENT_SOURCES]));
  });

  it('mirrors the private-source set the panel gates loopback analysis on', () => {
    expect(literalArray('PRIVATE_SOURCES')).toEqual([...PRIVATE_UNTRUSTED_CONTENT_SOURCES]);
  });

  it('keeps public community content out of the private set', () => {
    // `stacker-news` is public: restricting it to a loopback classifier would
    // deny it the cloud providers `github-issue` is allowed to use.
    expect(UNTRUSTED_CONTENT_SOURCES).toContain('stacker-news');
    expect(PRIVATE_UNTRUSTED_CONTENT_SOURCES).not.toContain('stacker-news');
  });
});
