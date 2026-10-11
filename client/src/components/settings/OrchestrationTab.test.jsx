import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrchestrationTab from './OrchestrationTab';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getOrchestrationProfiles: vi.fn(),
  getProviders: vi.fn(),
  saveOrchestrationProfile: vi.fn(),
  updateOrchestrationProfile: vi.fn(),
  deleteOrchestrationProfile: vi.fn(),
}));

describe('OrchestrationTab', () => {
  const mockProfiles = [
    {
      id: 'heavy-planner',
      name: 'Heavy Planning / Lean Execution',
      description: 'High reasoning effort for architect',
      isBuiltin: true,
      profile: {
        architect: { effort: 'high' },
        implementer: { effort: 'low' },
        reviewer: { effort: 'medium' },
      },
    },
    {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'My custom profile',
      isBuiltin: false,
      profile: {
        architect: { provider: 'anthropic', model: 'claude-3-opus', effort: 'max' },
        implementer: { provider: 'anthropic', model: 'claude-3-5-sonnet', effort: 'low' },
        reviewer: { effort: 'medium' },
      },
    },
  ];

  const mockProviders = [
    { id: 'anthropic', name: 'Anthropic', enabled: true, models: ['claude-3-opus', 'claude-3-5-sonnet'] },
    { id: 'openai', name: 'OpenAI', enabled: true, models: ['gpt-4o'] },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    api.getOrchestrationProfiles.mockResolvedValue(mockProfiles);
    // Real shape of getProviders(): { activeProvider, providers } — a bare array here hid a crash.
    api.getProviders.mockResolvedValue({ activeProvider: 'anthropic', providers: mockProviders });
  });

  it('renders orchestration profiles list', async () => {
    render(<OrchestrationTab />);
    expect(screen.getByText(/Loading orchestration profiles/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Heavy Planning / Lean Execution')).toBeTruthy();
      expect(screen.getByText('Custom Team')).toBeTruthy();
      expect(screen.getByText('Built-in')).toBeTruthy();
    });
  });

  it('resolves provider display names from the { providers } response', async () => {
    render(<OrchestrationTab />);
    await waitFor(() => expect(screen.getByText('Custom Team')).toBeTruthy());
    // Falls back to the raw id ("anthropic") when the providers list fails to load.
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0);
    expect(screen.queryByText('anthropic')).toBeNull();
  });

  it('distinguishes an unavailable inventory from a successful empty retry', async () => {
    api.getOrchestrationProfiles.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce([]);
    render(<OrchestrationTab />);
    expect(await screen.findByText('Orchestration profiles are unavailable.')).toBeTruthy();
    expect(screen.queryByText('No orchestration profiles configured.')).toBeNull();
    expect(screen.queryByText('Create your first profile')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No orchestration profiles configured.')).toBeTruthy();
    expect(screen.queryByText('Orchestration profiles are unavailable.')).toBeNull();
  });

  it('recovers profiles on retry while provider metadata fails independently', async () => {
    api.getOrchestrationProfiles.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(mockProfiles);
    api.getProviders.mockRejectedValue(new Error('Unavailable'));
    render(<OrchestrationTab />);
    await screen.findByText('Orchestration profiles are unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Custom Team')).toBeTruthy();
    expect(screen.getByText(/Provider metadata is unavailable/)).toBeTruthy();
    expect(screen.getAllByText('anthropic').length).toBeGreaterThan(0);
    expect(screen.queryByText('No orchestration profiles configured.')).toBeNull();
  });

  it('retains profiles and provider names when a refresh fails, then clears stale notices on recovery', async () => {
    api.getProviders.mockRejectedValueOnce(new Error('Unavailable'));
    render(<OrchestrationTab />);
    await screen.findByText('Custom Team');
    api.getOrchestrationProfiles.mockRejectedValueOnce(new Error('Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Showing previously loaded profiles/)).toBeTruthy();
    expect(screen.getByText('Custom Team')).toBeTruthy();
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0);
    expect(screen.queryByText('No orchestration profiles configured.')).toBeNull();

    api.getProviders.mockRejectedValueOnce(new Error('Unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Showing previously loaded profiles/)).toBeNull());
    expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0);
    expect(screen.getByText(/Provider metadata is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Provider metadata is unavailable/)).toBeNull());
  });

  it('opens create profile form and saves', async () => {
    api.saveOrchestrationProfile.mockResolvedValue({
      id: 'new-profile',
      name: 'New Profile',
      profile: {},
    });

    render(<OrchestrationTab />);
    await waitFor(() => expect(screen.getByText('Custom Team')).toBeTruthy());

    fireEvent.click(screen.getByText('New Profile'));
    expect(screen.getByText('Create Orchestration Profile')).toBeTruthy();

    const nameInput = screen.getByPlaceholderText(/e\.g\. Heavy Planner/i);
    fireEvent.change(nameInput, { target: { value: 'Test Profile' } });

    fireEvent.click(screen.getByText('Save Profile'));
    await waitFor(() => {
      expect(api.saveOrchestrationProfile).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Test Profile',
      }));
    });
  });

  it('confirms inline before deleting a non-builtin profile', async () => {
    api.deleteOrchestrationProfile.mockResolvedValue({ success: true });

    render(<OrchestrationTab />);
    await waitFor(() => expect(screen.getByText('Custom Team')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Delete profile Custom Team'));
    expect(api.deleteOrchestrationProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(api.deleteOrchestrationProfile).toHaveBeenCalledWith('custom-team');
    });
  });
});
