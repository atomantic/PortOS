import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChromeUpdatePanel from './ChromeUpdatePanel';
import { getBrowserUpdateStatus } from '../../../services/api';

const listeners = vi.hoisted(() => new Map());
vi.mock('../../../services/socket', () => ({ default: {
  on: vi.fn((name, handler) => listeners.set(name, handler)),
  off: vi.fn((name) => listeners.delete(name)),
} }));
vi.mock('../../../services/api', () => ({ getBrowserUpdateStatus: vi.fn() }));

beforeEach(() => { listeners.clear(); vi.resetAllMocks(); });

describe('Chrome update panel', () => {
  it('offers browser controls for a confirmed installed update and refreshes after status changes', async () => {
    getBrowserUpdateStatus.mockResolvedValue({ state: 'restart-required', runningVersion: '156.0.8078.4',
      installedVersion: '156.0.8078.74', publishedVersions: { mac_arm64: '156.0.8078.74', mac: '156.0.8078.73' }, channel: 'stable' });
    render(<MemoryRouter><ChromeUpdatePanel /></MemoryRouter>);
    expect(await screen.findByText(/An installed update needs a browser restart/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open browser controls' })).toHaveAttribute('href', '/browser');
    getBrowserUpdateStatus.mockResolvedValue({ state: 'current', runningVersion: '156.0.8078.74',
      installedVersion: '156.0.8078.74', publishedVersions: { mac_arm64: '157.0.9000.1', mac: '157.0.9000.2' }, channel: 'stable' });
    await act(async () => listeners.get('review:queue:changed')());
    expect(await screen.findByText(/157.0.9000.1/)).toHaveTextContent('Rollout availability can differ');
    expect(screen.queryByRole('link', { name: 'Open browser controls' })).not.toBeInTheDocument();
  });

  it('shows unverified status without creating a restart action', async () => {
    getBrowserUpdateStatus.mockResolvedValue({ state: 'unverified' });
    render(<MemoryRouter><ChromeUpdatePanel /></MemoryRouter>);
    expect(await screen.findByText(/could not be verified/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open browser controls' })).not.toBeInTheDocument();
  });

  it('surfaces a confirmed older version after a restart', async () => {
    getBrowserUpdateStatus.mockResolvedValue({ state: 'current', runningVersion: '1.0.0.1', installedVersion: '1.0.0.1',
      channel: 'stable', restartVerification: { state: 'older', expectedVersion: '1.0.0.2' } });
    render(<MemoryRouter><ChromeUpdatePanel /></MemoryRouter>);
    expect(await screen.findByText(/differs from the reviewed version 1.0.0.2/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chrome update instructions' })).toBeInTheDocument();
  });
});
