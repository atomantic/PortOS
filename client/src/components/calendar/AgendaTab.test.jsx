import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { socketMock } = vi.hoisted(() => ({
  socketMock: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../services/socket', () => ({ default: socketMock }));
vi.mock('../../services/api', () => ({
  getCalendarEvents: vi.fn(),
  syncCalendarAccount: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../services/api';
import AgendaTab from './AgendaTab';

function LocationProbe() {
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}

async function renderAgenda(accounts) {
  render(
    <MemoryRouter initialEntries={['/calendar/agenda']}>
      <Routes>
        <Route
          path="*"
          element={<><AgendaTab accounts={accounts} /><LocationProbe /></>}
        />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {});
}

describe('AgendaTab empty states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCalendarEvents.mockResolvedValue({ events: [] });
  });

  it('directs users without an enabled account to calendar sync', async () => {
    await renderAgenda([{ id: 'disabled', name: 'Personal', enabled: false }]);

    const connectLink = await screen.findByRole('link', { name: 'Connect a calendar' });
    expect(connectLink.getAttribute('href')).toBe('/calendar/sync');
    expect(screen.getByText('No calendar connected')).toBeTruthy();
    expect(screen.queryByText('Sync your calendar accounts to see events here')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();

    fireEvent.click(connectLink);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/calendar/sync');
  });

  it('offers an enabled in-page sync action when accounts have no events', async () => {
    await renderAgenda([{ id: 'enabled', name: 'Personal', enabled: true }]);

    expect(await screen.findByText('Sync now to pull upcoming events')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeDisabled();
  });

  it('offers to clear active filters instead of suggesting a sync', async () => {
    await renderAgenda([{ id: 'enabled', name: 'Personal', enabled: true }]);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Search events' }), {
      target: { value: 'missing' },
    });

    expect(await screen.findByText('No matching events')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });
});
