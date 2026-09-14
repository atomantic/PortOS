import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import MediaGen, { TABS } from './MediaGen.jsx';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

describe('<MediaGen>', () => {
  it('keeps every tab on the phone as a named icon link rather than a select', () => {
    render(
      <MemoryRouter initialEntries={['/media/image']}>
        <MediaGen />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('combobox')).toBeNull();
    const bar = screen.getByRole('tablist', { name: 'Media Gen sections' });
    const tabs = within(bar).getAllByRole('tab');
    expect(tabs).toHaveLength(TABS.length);
    // Each tab still carries its icon and its name; only the visible label goes.
    expect(tabs.every((tab) => tab.querySelector('svg') && tab.querySelector('.max-sm\\:sr-only'))).toBe(true);
    expect(within(bar).getByRole('tab', { name: 'Image' })).toHaveAttribute('aria-selected', 'true');
  });

  it('marks the Video tab active on /video/generate', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/video/generate']}>
        <MediaGen />
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('.flex-1.overflow-auto')).toBeTruthy();
  });
});

// Media Gen derives its tab bar from the nav manifest's `tabGroup: 'media'`
// (#6383) — this pins the id/label/order the page means to render, and that
// every manifest tab has a presentation entry (icon) in MediaGen.jsx, which
// would otherwise only surface as a thrown import-time error. The short
// "History"/"Three.js" labels come from the manifest's `tabLabel`.
describe('MediaGen TABS ↔ nav manifest', () => {
  it('renders the media tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'image:Image', 'video:Video', 'threejs:Three.js', 'annotate:Annotate',
      'timeline:Timeline', 'history:History', 'collections:Collections',
    ]);
  });
});
