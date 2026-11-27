import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../components/MortalLoomBanner', () => ({ default: () => null }));
vi.mock('../components/meatspace/tabs/OverviewTab', () => ({ default: () => <p>Overview content</p> }));
vi.mock('../components/meatspace/tabs/HealthTab', () => ({ default: () => <p>Health content</p> }));

import MeatSpace from './MeatSpace';

afterEach(cleanup);

it('associates the active tab with its panel when falling back to Overview and when switching tabs', async () => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/meatspace/unknown']}>
        <Routes>
          <Route path="/meatspace/:tab" element={<MeatSpace />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  const overview = screen.getByRole('tab', { name: 'Overview', selected: true });
  const overviewPanel = screen.getByRole('tabpanel', { name: 'Overview' });
  expect(overview).toHaveAttribute('aria-controls', overviewPanel.id);
  expect(overviewPanel).toHaveAttribute('aria-labelledby', overview.id);
  expect(await screen.findByText('Overview content')).toBeVisible();

  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Health' }));
  });

  const health = await screen.findByRole('tab', { name: 'Health', selected: true });
  const healthPanel = screen.getByRole('tabpanel', { name: 'Health' });
  expect(health).toHaveAttribute('aria-controls', healthPanel.id);
  expect(healthPanel).toHaveAttribute('aria-labelledby', health.id);
  expect(overview).not.toHaveAttribute('aria-controls');
  expect(await screen.findByText('Health content')).toBeVisible();
});
