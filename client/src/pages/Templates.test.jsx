import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getTemplates: vi.fn(),
  createFromTemplate: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../components/FolderPicker', () => ({
  default: () => <div data-testid="folder-picker" />,
}));

import Templates from './Templates';

describe('Templates list resources (#12171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error row with Retry when templates fail to load, and recovers on retry', async () => {
    api.getTemplates.mockRejectedValueOnce(new Error('templates service down'));

    render(
      <MemoryRouter>
        <Templates />
      </MemoryRouter>
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load app templates — templates service down');

    api.getTemplates.mockResolvedValueOnce([
      { id: 'tpl-1', name: 'React App', description: 'Standard React template', icon: 'code', builtIn: true }
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByText('React App')).toBeInTheDocument();
  });

  it('shows empty copy when templates list is empty', async () => {
    api.getTemplates.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Templates />
      </MemoryRouter>
    );

    expect(await screen.findByText('No app templates available.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Add Custom Template')).toBeInTheDocument();
  });
});
