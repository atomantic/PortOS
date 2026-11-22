import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

const api = vi.hoisted(() => ({
  getTemplates: vi.fn(),
  createFromTemplate: vi.fn(),
}));

vi.mock('../services/apiScaffold.js', () => ({
  getTemplates: api.getTemplates,
  createFromTemplate: api.createFromTemplate,
}));
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
    expect(screen.queryByText('Add Custom Template')).not.toBeInTheDocument();
  });

  const TPL = [{ id: 'tpl-1', name: 'React App', description: 'Standard React template', icon: 'code', builtIn: true }];
  const Where = () => <div data-testid="loc">{useLocation().search}</div>;
  const renderAt = (url) => render(
    <MemoryRouter initialEntries={[url]}>
      <Templates />
      <Where />
    </MemoryRouter>
  );

  it('opens the creation form from ?template=<id> and Back returns to the list', async () => {
    api.getTemplates.mockResolvedValue(TPL);
    renderAt('/templates?template=tpl-1');

    expect(await screen.findByLabelText(/App Name/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(await screen.findByRole('button', { name: /React App/ })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('');
  });

  it('selecting a card writes ?template=<id>', async () => {
    api.getTemplates.mockResolvedValue(TPL);
    renderAt('/templates');

    fireEvent.click(await screen.findByRole('button', { name: /React App/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('?template=tpl-1');
    expect(await screen.findByLabelText(/App Name/)).toBeInTheDocument();
  });

  it('clears an unknown ?template= and shows the list', async () => {
    api.getTemplates.mockResolvedValue(TPL);
    renderAt('/templates?template=nope');

    expect(await screen.findByRole('button', { name: /React App/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^$/));
  });

  it('creates silently so a failure shows only the inline alert', async () => {
    api.getTemplates.mockResolvedValue(TPL);
    api.createFromTemplate.mockRejectedValue(new Error('scaffold failed'));
    renderAt('/templates?template=tpl-1');

    fireEvent.change(await screen.findByLabelText(/App Name/), { target: { value: 'my-app' } });
    fireEvent.change(screen.getByLabelText(/Target Directory/), { target: { value: '/tmp/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create App' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('scaffold failed');
    expect(api.createFromTemplate).toHaveBeenCalledWith(
      { templateId: 'tpl-1', name: 'my-app', targetPath: '/tmp/x' },
      { silent: true }
    );
  });
});
