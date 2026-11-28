import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ installLocalLlmModel: vi.fn() }));
vi.mock('../../services/apiLocalLlm.js', () => ({ installLocalLlmModel: mocks.installLocalLlmModel }));

import { RECOMMENDED_FAST_VOICE_MODEL } from '../../../../server/lib/voiceModelCatalog.js';
import FastVoiceModelNotice from './FastVoiceModelNotice';

const { id, name, providerId } = RECOMMENDED_FAST_VOICE_MODEL;
const ollama = (models) => ({ id: providerId, type: 'api', name: 'Ollama', models });
const LLAMA = { id: 'llama-server', type: 'api', name: 'llama.cpp (local)', models: ['example-org/voice-model'] };

describe('FastVoiceModelNotice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing without an Ollama provider', () => {
    const { container } = render(<FastVoiceModelNotice apiProviders={[LLAMA]} selectedProviderId="llama-server" selectedModelId="auto" onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms when the recommended model is already selected', () => {
    render(<FastVoiceModelNotice apiProviders={[ollama([id])]} selectedProviderId={providerId} selectedModelId={id} onChange={vi.fn()} />);
    expect(screen.getByText(/fastest tested local Voice brain/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('switches provider and model in one click when Ollama has it', () => {
    const onChange = vi.fn();
    render(<FastVoiceModelNotice apiProviders={[LLAMA, ollama(['other:7b', id])]} selectedProviderId="llama-server" selectedModelId="example-org/voice-model" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: `Use ${name}` }));
    expect(onChange).toHaveBeenCalledWith({ provider: providerId, model: id });
    expect(mocks.installLocalLlmModel).not.toHaveBeenCalled();
  });

  it('pulls the model, refreshes the list, then selects it', async () => {
    mocks.installLocalLlmModel.mockResolvedValue({});
    const onChange = vi.fn();
    const onRefreshModels = vi.fn().mockResolvedValue();
    render(<FastVoiceModelNotice apiProviders={[ollama([])]} selectedProviderId="llama-server" selectedModelId="auto" onChange={onChange} onRefreshModels={onRefreshModels} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Pull ${name}`) }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ provider: providerId, model: id }));
    expect(mocks.installLocalLlmModel).toHaveBeenCalledWith(providerId, id, { silent: true });
    expect(onRefreshModels).toHaveBeenCalledWith(providerId);
  });

  it('shows the error and keeps the current model when the pull fails', async () => {
    mocks.installLocalLlmModel.mockRejectedValue(new Error('Ollama is not running'));
    const onChange = vi.fn();
    render(<FastVoiceModelNotice apiProviders={[ollama([])]} selectedProviderId="llama-server" selectedModelId="auto" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Pull ${name}`) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ollama is not running');
    expect(onChange).not.toHaveBeenCalled();
  });
});
