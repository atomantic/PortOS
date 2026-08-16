import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
