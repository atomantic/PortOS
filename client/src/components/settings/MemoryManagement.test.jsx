import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
import MemoryManagement from './MemoryManagement.jsx';

describe('MemoryManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLoadedLlmModels.mockResolvedValue({
      ollama: [],
      lmstudio: [{ id: 'example/lmstudio-model', state: 'loaded' }],
    });
    unloadLmStudioModel.mockResolvedValue({ success: true });
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
});
