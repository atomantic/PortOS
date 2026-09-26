import socket from '../../services/socket';
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
const socketEvent = event => { for (const [name, handler] of socket.on.mock.calls) if (name === event) handler({}); };
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiLocalLlm.js', () => ({
  getLoadedLlmModels: vi.fn(),
  unloadLmStudioModel: vi.fn(),
  unloadOllamaModel: vi.fn(),
}));

vi.mock('../../services/apiVoice.js', () => ({
  getTtsStatus: vi.fn(async () => ({ kokoro: { state: 'lazy', loadedKey: null } })),
  unloadKokoroTts: vi.fn(),
  controlWhisper: vi.fn(),
  getVoiceStatus: vi.fn(async () => ({ sttEngine: 'piper', services: {} })),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { getLoadedLlmModels, unloadLmStudioModel } from '../../services/apiLocalLlm.js';
import { getTtsStatus, getVoiceStatus } from '../../services/apiVoice.js';
import toast from '../ui/Toast';
import MemoryManagement from './MemoryManagement.jsx';

describe('MemoryManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLoadedLlmModels.mockResolvedValue({
      ollama: [],
      lmstudio: [{ id: 'example/lmstudio-model', state: 'loaded' }],
    });
    unloadLmStudioModel.mockResolvedValue({ success: true });
    getTtsStatus.mockResolvedValue({ kokoro: { state: 'lazy', loadedKey: null } });
    getVoiceStatus.mockResolvedValue({ sttEngine: 'piper', services: {} });
  });

  it('shows and unloads LM Studio models from the unified residency endpoint', async () => {
    render(<MemoryManagement />);

    expect(await screen.findByText('example/lmstudio-model')).toBeInTheDocument();
    expect(screen.getByText('LM Studio')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unload example/lmstudio-model' }));

    await waitFor(() => expect(unloadLmStudioModel).toHaveBeenCalledWith(
      'example/lmstudio-model',
      { silent: true },
    ));
  });

  it('never claims memory is free when fresh status probes fail', async () => {
    render(<MemoryManagement />);
    expect(await screen.findByText('example/lmstudio-model')).toBeInTheDocument();

    getLoadedLlmModels.mockRejectedValueOnce(new Error('LLM status failed'));
    getTtsStatus.mockRejectedValueOnce(new Error('TTS status failed'));
    getVoiceStatus.mockRejectedValueOnce(new Error('voice status failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Free everything' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('could not verify')));
    expect(unloadLmStudioModel).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith('Freed all memory-resident models');
    expect(screen.queryByText(/full unified memory is available/i)).not.toBeInTheDocument();
  });

  it('ignores an older refresh that resolves after a newer snapshot', async () => {
    render(<MemoryManagement />);
    expect(await screen.findByText('example/lmstudio-model')).toBeInTheDocument();

    let resolveSlow;
    getLoadedLlmModels
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }))
      .mockResolvedValueOnce({ ollama: [], lmstudio: [{ id: 'newer-model', state: 'loaded' }] });

    const refresh = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(await screen.findByText('newer-model')).toBeInTheDocument();

    await act(async () => {
      resolveSlow({ ollama: [], lmstudio: [{ id: 'older-model', state: 'loaded' }] });
      await Promise.resolve();
    });
    expect(screen.queryByText('older-model')).not.toBeInTheDocument();
    expect(screen.getByText('newer-model')).toBeInTheDocument();
    });

  it('does not let a pre-unload socket read resurrect the model', async () => {
    render(<MemoryManagement />);
    expect(await screen.findByText('example/lmstudio-model')).toBeInTheDocument();
    let resolveOld;
    getLoadedLlmModels.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    act(() => socketEvent('loaded-models:changed'));
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    getLoadedLlmModels.mockResolvedValue({ ollama: [], lmstudio: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Unload example/lmstudio-model' }));
    await waitFor(() => expect(screen.queryByText('example/lmstudio-model')).not.toBeInTheDocument());
    await act(async () => resolveOld({ ollama: [], lmstudio: [{ id: 'example/lmstudio-model' }] }));
    expect(screen.queryByText('example/lmstudio-model')).not.toBeInTheDocument();
  });

  it('hides the unavailability banner for a user-disabled backend', async () => {
       // A backend the user marked disabled opts out of the availability nag. Its
       // failed residency still lands in unavailableSources (the "Free everything"
       // guard), but the banner excludes it.
    getLoadedLlmModels.mockResolvedValue({
       ollama: [],
       lmstudio: [],
       sourceErrors: ['lmstudio'],
       disabled: ['lmstudio'],
       });

    render(<MemoryManagement />);

     // Wait for the first refresh to clear the loading state so the poll result
     // is the thing under test, not the pre-poll empty render.
    expect(await screen.findByRole('button', { name: 'Free everything' })).toBeInTheDocument();
     // The banned nag is suppressed for the disabled backend, even though its
     // residency is unknown.
    expect(screen.queryByText(/Status unavailable for LM Studio/i)).not.toBeInTheDocument();
     // The "free everything" guard and empty-state check still key off the full
     // unavailable list, so "nothing resident" is NOT claimed while lmstudio's
     // residency is unconfirmed.
    expect(screen.queryByText(/full unified memory is available/i)).not.toBeInTheDocument();
        });

  describe('socket reconciliation', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('updates on events, reconnect and tab show without any timer-driven fetch', async () => {
      render(<MemoryManagement />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(getLoadedLlmModels).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(getLoadedLlmModels).toHaveBeenCalledTimes(1);
      getLoadedLlmModels.mockResolvedValue({ ollama: [], lmstudio: [{ id: 'event-model' }] });
      await act(async () => { socketEvent('loaded-models:changed'); });
      expect(screen.getByText('event-model')).toBeInTheDocument();
      await act(async () => { socketEvent('connect'); });
      expect(getLoadedLlmModels).toHaveBeenCalledTimes(3);
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(getLoadedLlmModels).toHaveBeenCalledTimes(3);

      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getLoadedLlmModels).toHaveBeenCalledTimes(4);
      visibility.mockRestore();
    });
  });

  it('keeps a backend disabled across a later failed poll', async () => {
          // The banner-suppression scenario IS a transient outage, so a failed poll
          // must not resurrect the warning for a backend a good poll already marked
          // disabled — disabled sources are retained (present-vs-empty, not falsy).
     getLoadedLlmModels
           .mockResolvedValueOnce({
             ollama: [],
             lmstudio: [],
             sourceErrors: ['lmstudio'],
             disabled: ['lmstudio'],
             })
           .mockRejectedValueOnce(new Error('LLM status failed'));

    render(<MemoryManagement />);
       // First (good) poll: lmstudio is known-disabled, so the banner is silent even
       // though its residency error would otherwise show.
    expect(await screen.findByRole('button', { name: 'Free everything' })).toBeInTheDocument();
    expect(screen.queryByText(/Status unavailable for/i)).not.toBeInTheDocument();
       // A later FAILED poll re-adds both backends to unavailableSources, but the
       // still-known-disabled lmstudio must stay excluded from the banner (ollama,
       // which is enabled, shows instead).
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(getLoadedLlmModels).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Status unavailable for Ollama/i)).toBeInTheDocument();
    expect(screen.queryByText(/LM Studio/i)).not.toBeInTheDocument();
       });
});
