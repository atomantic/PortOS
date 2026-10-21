import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({ getDockerContainmentStatus: vi.fn(), pullDockerContainmentImage: vi.fn() }));
vi.mock('../../services/api', () => mock);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import DockerContainmentCard from './DockerContainmentCard';

const READY = {
  enabled: true, state: 'ready', ready: true, message: 'Docker Desktop 29.0.0 is ready (context desktop-linux).',
  engine: { kind: 'desktop', label: 'Docker Desktop', context: 'desktop-linux', serverVersion: '29.0.0' },
  images: [{ major: 24, ref: 'node:24@sha256:x', present: true }, { major: 26, ref: 'node:26@sha256:y', present: false }],
};

describe('DockerContainmentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getDockerContainmentStatus.mockResolvedValue(READY);
    mock.pullDockerContainmentImage.mockResolvedValue({ ok: true });
  });

  it('shows the selected engine and pulls a missing image only on request', async () => {
    render(<DockerContainmentCard />);
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText('Docker Desktop 29.0.0')).toBeTruthy();
    expect(screen.getByText('desktop-linux')).toBeTruthy();
    expect(mock.pullDockerContainmentImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pull image' }));
    await waitFor(() => expect(mock.pullDockerContainmentImage).toHaveBeenCalledWith(26, { silent: true }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Pull image' })).toBeNull());
    expect(screen.getAllByText('pulled')).toHaveLength(2);
  });

  it('names why Docker is unavailable and offers no pull', async () => {
    mock.getDockerContainmentStatus.mockResolvedValue({ ...READY, state: 'docker-stopped', ready: false, message: 'Docker is installed but no local engine answered.', engine: null });
    render(<DockerContainmentCard />);
    expect(await screen.findByText('Docker is not running')).toBeTruthy();
    expect(screen.getByText('Docker is installed but no local engine answered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pull image' })).toBeNull();
  });
});
