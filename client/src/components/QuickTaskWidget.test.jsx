import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuickTaskWidget from './QuickTaskWidget';

const api = vi.hoisted(() => ({ getProviders: vi.fn(), getApps: vi.fn() }));

vi.mock('../services/api', () => api);
vi.mock('./cos/TaskAddForm', () => ({
  default: ({ providers, apps }) => <div data-testid="task-form">{providers.length} providers, {apps.length} apps</div>,
}));

const renderWidget = () => render(<MemoryRouter><QuickTaskWidget /></MemoryRouter>);

describe('QuickTaskWidget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an error row with Retry, not a form with no providers, when a read fails', async () => {
    api.getProviders.mockResolvedValue({ providers: [{ id: 'p1' }] });
    api.getApps.mockRejectedValueOnce(new Error('apps 502'));
    renderWidget();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load apps — apps 502');
    expect(screen.queryByTestId('task-form')).not.toBeInTheDocument();

    api.getApps.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('task-form')).toHaveTextContent('1 providers, 2 apps'));
  });
});
