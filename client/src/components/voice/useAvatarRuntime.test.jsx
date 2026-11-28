import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ changeVoiceAvatar: vi.fn(), resource: { data: null, updateData: vi.fn() } }));
vi.mock('../../services/apiVoiceAvatar', () => ({ changeVoiceAvatar: mocks.changeVoiceAvatar, fetchVoiceAvatar: vi.fn() }));
vi.mock('../../hooks/useSocketResource', () => ({ useSocketResource: () => mocks.resource }));

import { shouldAutoStartAvatar, useAvatarRuntime } from './useAvatarRuntime';

const ready = { supported: true, installed: true, updateAvailable: false, phase: 'stopped', autoStart: true };

describe('useAvatarRuntime auto-start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resource = { data: ready, updateData: vi.fn() };
    mocks.changeVoiceAvatar.mockResolvedValue({ ...ready, phase: 'starting' });
  });

  it('starts an installed, stopped avatar once when a call view asks for it', async () => {
    const { rerender } = renderHook(() => useAvatarRuntime(true, { autoStart: true }));
    await waitFor(() => expect(mocks.resource.updateData).toHaveBeenCalledWith({ ...ready, phase: 'starting' }));
    rerender();
    expect(mocks.changeVoiceAvatar).toHaveBeenCalledTimes(1);
    expect(mocks.changeVoiceAvatar).toHaveBeenCalledWith('autostart');
  });

  it('leaves the avatar alone for views without autoStart', () => {
    renderHook(() => useAvatarRuntime(true));
    expect(mocks.changeVoiceAvatar).not.toHaveBeenCalled();
  });

  it.each([
    ['not installed', { installed: false }],
    ['an update is pending', { updateAvailable: true }],
    ['already running', { phase: 'running' }],
    ['a failed start', { phase: 'failed' }],
    ['auto-start turned off', { autoStart: false }],
  ])('does not start when %s', (_label, patch) => {
    expect(shouldAutoStartAvatar({ ...ready, ...patch })).toBe(false);
  });
});
