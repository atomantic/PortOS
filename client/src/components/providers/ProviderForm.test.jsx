import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

import ProviderForm from './ProviderForm';

// Mounting the form on its own is the point of the extraction: the page-level
// suite has to stand up API + socket wiring to reach a single input, so the
// tab-state invariants below were previously unreachable in isolation.
const renderForm = (props = {}) => render(
  <MemoryRouter initialEntries={['/ai/new']}>
    <ProviderForm onClose={vi.fn()} onSave={vi.fn()} onEditProvider={vi.fn()} {...props} />
  </MemoryRouter>
);

const switchTab = (name) => fireEvent.click(screen.getByRole('tab', { name }));

describe('ProviderForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createProvider.mockResolvedValue({});
    api.updateProvider.mockResolvedValue({});
  });

  it('renders every editor tab', () => {
    renderForm();
    for (const label of ['Connection', 'Models', 'Generation', 'Environment']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  // The Drawer body remounts per tab (key={currentTab}), so any field state left
  // inside a panel would be wiped on a tab switch. All of it is hoisted into the
  // form component above the Drawer — this is the regression guard for that.
  it('keeps entered values when a tab switch unmounts their fields', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });

    switchTab('Generation');
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Planning Window'), { target: { value: '8192' } });

    switchTab('Connection');
    expect(screen.getByLabelText('Name *')).toHaveValue('Example Provider');

    switchTab('Generation');
    expect(screen.getByLabelText('Planning Window')).toHaveValue(8192);
  });

  // A number input on an unmounted tab is never validated by the browser, so
  // submit re-checks the ranges itself, jumps to the offending tab, and toasts.
  it('blocks submit on an out-of-range numeric field and reveals the tab that owns it', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'echo' } });

    switchTab('Generation');
    fireEvent.change(screen.getByLabelText('Planning Window'), { target: { value: '10' } });

    switchTab('Connection');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Planning Window must be between 512 and 2,097,152 tokens');
    });
    expect(api.createProvider).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Planning Window')).toBeInTheDocument();
  });
});
