import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiCore.js', async (importOriginal) => ({
  ...await importOriginal(), request: vi.fn()
}));
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../hooks/useInstanceFeatures.js', () => ({ useInstanceFeatures: () => ({ features: [] }) }));
vi.mock('../components/onboarding/FirstRunCard.jsx', () => ({ default: () => null }));
vi.mock('../components/dashboard/LayoutPicker', () => ({ default: () => null }));
vi.mock('../components/dashboard/LayoutEditor', () => ({ default: () => null }));
vi.mock('../components/dashboard/DashboardGrid.jsx', async (importOriginal) => ({
  ...await importOriginal(),
  default: ({ items, renderItem }) => <div data-testid="grid" data-widgets={items.map((item) => item.id).join(',')}>
    {items.map((item) => <div key={item.id}>{renderItem(item)}</div>)}
  </div>
}));

import { request } from '../services/apiCore.js';
import socket from '../services/socket';
import Dashboard from './Dashboard.jsx';

// Exercise the real API wrapper, registry gate and hourly widget through Dashboard.
describe('Dashboard hourly usage hydration', () => {
  it('uses only the hourly endpoint on mount and app changes, preserving data and the zero gate', async () => {
    let hourlyActivity = Array(24).fill(0);
    hourlyActivity[9] = 7;
    request.mockImplementation(async (path) => {
      if (path === '/usage/hourly') return { hourlyActivity };
      if (path === '/apps') return [];
      if (path === '/dashboard/layouts') return {
        layouts: [{ id: 'hourly', name: 'Hourly', widgets: ['hourly-activity'] }],
        activeLayoutId: 'hourly'
      };
      return {};
    });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText('7 total sessions tracked')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Hourly activity heatmap' }).children).toHaveLength(24);
    expect(request.mock.calls.filter(([path]) => path === '/usage/hourly')).toEqual([
      ['/usage/hourly', { silent: true }]
    ]);
    const onAppsChanged = socket.on.mock.calls.find(([event]) => event === 'apps:changed')[1];
    hourlyActivity = Array(24).fill(0);
    await act(async () => onAppsChanged());
    await waitFor(() => expect(screen.queryByText('Activity by Hour')).not.toBeInTheDocument());
    expect(screen.queryByTestId('grid')).not.toBeInTheDocument();
    expect(screen.getByText(/This layout has no widgets/)).toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path === '/usage/hourly')).toHaveLength(2);
    expect(request.mock.calls.some(([path]) => path === '/usage' || path.startsWith('/usage?'))).toBe(false);
  });
});
