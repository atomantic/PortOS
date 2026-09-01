import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import MediaGen, { TABS } from './MediaGen.jsx';

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
});
