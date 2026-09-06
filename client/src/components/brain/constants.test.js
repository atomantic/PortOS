import { describe, expect, it } from 'vitest';
import { FULL_BLEED_TAB_IDS, MEMORY_TABS, TABS } from './constants';
import { expectPageNavTabs } from '../../test/pageNavTabAssertions.js';

describe('Brain navigation', () => {
  it('keeps native Ideas on its dedicated URL-backed Brain tab', () => {
    expect(TABS.map(({ id }) => id)).toContain('ideas');
    expect(MEMORY_TABS.map(({ id }) => id)).not.toContain('ideas');
  });
});

// Brain derives its tab bar from the nav manifest's `tabGroup: 'brain'` (#6383)
// — this pins the id/label/order the page means to render, and that every
// manifest tab has a presentation entry (icon, `fullBleed`) in constants.js,
// which would otherwise only surface as a thrown import-time error.
describe('Brain TABS ↔ nav manifest', () => {
  it('renders the brain tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'inbox:Inbox', 'ideas:Ideas', 'daily-log:Daily Log', 'links:Links',
      'memory:Memory', 'notes:Notes', 'graph:Graph', 'digest:Digest',
      'feeds:Feeds', 'trust:Trust', 'import:Import', 'spotify:Spotify',
      'youtube:YouTube', 'config:Config',
    ]);
  });

  it('keeps the full-bleed set derived from the presentation map', () => {
    expect([...FULL_BLEED_TAB_IDS].sort()).toEqual(['daily-log', 'graph', 'notes']);
  });
});
