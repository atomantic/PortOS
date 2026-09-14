import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import RouteTabsHeader from './RouteTabsHeader';
import { NAV_PRESENTATION } from '../../lib/navPresentation.js';
import { buildSectionNavTabs } from '../../lib/pageNavTabs.js';
import { getSectionNavTabs } from '../../../../server/lib/navManifest.js';

const settingsTabs = buildSectionNavTabs(getSectionNavTabs('Settings'), NAV_PRESENTATION, 'Settings');

const renderAt = (tabs, activeTab) => render(
  <MemoryRouter>
    <RouteTabsHeader tabs={tabs} activeTab={activeTab} ariaLabel="Demo sections" />
  </MemoryRouter>,
);

describe('RouteTabsHeader', () => {
  it('renders an icon row past the compact threshold instead of a select', () => {
    renderAt(settingsTabs, 'general');

    expect(screen.queryByRole('combobox')).toBeNull();
    const bar = screen.getByRole('tablist', { name: 'Demo sections' });
    for (const tab of within(bar).getAllByRole('tab')) {
      expect(tab.querySelector('svg')).toBeTruthy();
      expect(tab.querySelector('.max-sm\\:sr-only')).toBeTruthy();
    }
  });

  it('leaves a short bar\'s labels visible at every width', () => {
    renderAt(settingsTabs.slice(0, 3), 'general');

    const bar = screen.getByRole('tablist', { name: 'Demo sections' });
    expect(within(bar).getAllByRole('tab')[0].querySelector('.max-sm\\:sr-only')).toBeNull();
  });
});
