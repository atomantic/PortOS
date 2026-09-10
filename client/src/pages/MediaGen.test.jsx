import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import MediaGen, { TABS } from './MediaGen.jsx';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

describe('<MediaGen>', () => {
  it('provides a labeled mobile section selector for the full tab set', () => {
    render(
      <MemoryRouter initialEntries={['/media/image']}>
        <MediaGen />
      </MemoryRouter>,
    );

    const select = screen.getByRole('combobox', { name: 'Media Gen sections' });
    expect(select).toHaveAttribute('id', 'media-gen-section-select');
    expect(within(select).getAllByRole('option')).toHaveLength(TABS.length);
    expect(select).toHaveValue('image');
  });

  it('marks the Video tab active on /video/generate', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/video/generate']}>
        <MediaGen />
      </MemoryRouter>,
    );

    expect(screen.getByRole('combobox', { name: 'Media Gen sections' })).toHaveValue('video');
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
