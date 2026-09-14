import { describe, it, expect } from 'vitest';

import { NAV_PRESENTATION } from './navPresentation.js';
import { buildSectionNavTabs } from './pageNavTabs.js';
import { NAV_COMMANDS, getSectionNavTabs } from '../../../server/lib/navManifest.js';

const SECTIONS = [...new Set(NAV_COMMANDS.map((command) => command.section).filter(Boolean))]
  .map((section) => [section, getSectionNavTabs(section)])
  .filter(([, tabs]) => tabs.length > 0);

const iconName = (icon) => icon?.displayName || icon?.name;

// This registry is the single icon source for BOTH the sidebar and each
// section's sub-nav (`buildSectionNavTabs`), so its invariants are registry
// invariants, not any one component's. Both matter more than they look:
// a destination with no icon throws the whole section's nav, and two
// destinations sharing one are indistinguishable on a phone, where the
// sub-nav collapses to icons and the icon is all the user sees.
describe.each(SECTIONS)('%s destinations', (section, tabs) => {
  it('all resolve an icon, so the section can build its sub-nav', () => {
    expect(() => buildSectionNavTabs(tabs, NAV_PRESENTATION, section)).not.toThrow();
  });

  it('use a different icon each', () => {
    const names = tabs.map((tab) => iconName(NAV_PRESENTATION[tab.to]?.icon));
    expect(names).toEqual([...new Set(names)]);
  });
});

describe('buildSectionNavTabs', () => {
  it('names the destination whose icon is missing instead of degrading the bar', () => {
    expect(() => buildSectionNavTabs([{ id: 'x', to: '/not-a-nav-path' }], NAV_PRESENTATION, 'Demo'))
      .toThrow('Demo: no nav presentation icon for /not-a-nav-path');
  });
});
