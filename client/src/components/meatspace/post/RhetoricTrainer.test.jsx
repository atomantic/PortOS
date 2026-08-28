import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RhetoricTrainer from './RhetoricTrainer';
import { evaluateRhetoricAttempt, getLoadedLlmModels, getProviders, submitTrainingEntry } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  evaluateRhetoricAttempt: vi.fn(),
  getLoadedLlmModels: vi.fn(() => Promise.resolve({ ollama: [], lmstudio: [], sourceErrors: [] })),
  getProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  submitTrainingEntry: vi.fn(() => Promise.resolve()),
}));

describe('RhetoricTrainer', () => {
  const props = { onBack: vi.fn(), onSelectMode: vi.fn(), onExitMode: vi.fn(), onContinue: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    evaluateRhetoricAttempt.mockReset();
    getLoadedLlmModels.mockResolvedValue({ ollama: [], lmstudio: [], sourceErrors: [] });
    getProviders.mockResolvedValue({ providers: [] });
    submitTrainingEntry.mockResolvedValue();
  });

  it('shows loaded local models and preselects a resident model when no choice is saved', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'example-rhetoric:latest', name: 'example-rhetoric:latest' }],
      lmstudio: [],
      sourceErrors: [],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'example-cloud',
      providers: [
        { id: 'example-cloud', name: 'Example Cloud', enabled: true, models: ['example-cloud-model'] },
        { id: 'ollama', name: 'Ollama', enabled: true, models: [] },
      ],
    });

    render(<RhetoricTrainer {...props} config={{ rhetoricEvaluator: { enabled: false } }} />);

    expect(await screen.findByText('Loaded local models')).toBeInTheDocument();
    expect(screen.getByText('example-rhetoric:latest · Ollama')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('ollama');
      expect(screen.getByLabelText('Model')).toHaveValue('example-rhetoric:latest');
    });
  });

  it('preserves a saved evaluator choice when a local model is loaded', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'example-rhetoric:latest', name: 'example-rhetoric:latest' }],
      lmstudio: [],
      sourceErrors: [],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'ollama',
      providers: [
        { id: 'example-cloud', name: 'Example Cloud', enabled: true, models: ['example-cloud-model'] },
        { id: 'ollama', name: 'Ollama', enabled: true, models: [] },
      ],
    });

    render(<RhetoricTrainer
      {...props}
      config={{ rhetoricEvaluator: { enabled: true, providerId: 'example-cloud', model: 'example-cloud-model' } }}
    />);

    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('example-cloud');
      expect(screen.getByLabelText('Model')).toHaveValue('example-cloud-model');
    });
  });

  it('shows partial residency status without claiming no local models are loaded', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'example-rhetoric:latest', name: 'example-rhetoric:latest' }],
      lmstudio: [],
      sourceErrors: ['lmstudio'],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'ollama',
      providers: [{ id: 'ollama', name: 'Ollama', enabled: true, models: [] }],
    });

    render(<RhetoricTrainer {...props} config={{ rhetoricEvaluator: { enabled: false } }} />);

    expect(await screen.findByText('Loaded local models')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't verify residency for LM Studio/)).toBeInTheDocument();
    expect(screen.queryByText(/No local models are loaded/)).not.toBeInTheDocument();
  });

  it('does not preselect embedding-only resident models', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'nomic-embed-text:latest', name: 'nomic-embed-text:latest' }],
      lmstudio: [{ id: 'example-embed', name: 'example-embed', type: 'embeddings' }],
      sourceErrors: [],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'ollama',
      providers: [{ id: 'ollama', name: 'Ollama', enabled: true, models: [] }],
    });

    render(<RhetoricTrainer {...props} config={{ rhetoricEvaluator: { enabled: false } }} />);

    expect(await screen.findByText('Loaded local models')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('');
      expect(screen.getByLabelText('Model')).toHaveValue('');
    });
    expect(screen.queryByRole('option', { name: 'nomic-embed-text:latest' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'example-embed' })).not.toBeInTheDocument();
  });

  it('maps an Ollama-backed wrapper provider to resident Ollama models', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'example-rhetoric:latest', name: 'example-rhetoric:latest' }],
      lmstudio: [],
      sourceErrors: [],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'opencode-ollama-tui',
      providers: [{ id: 'opencode-ollama-tui', name: 'OpenCode Ollama TUI', enabled: true, models: [], ollamaBacked: true }],
    });

    render(<RhetoricTrainer {...props} config={{ rhetoricEvaluator: { enabled: false } }} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('opencode-ollama-tui');
      expect(screen.getByLabelText('Model')).toHaveValue('example-rhetoric:latest');
    });
  });

  it('checks local residency when POST config is unavailable and preserves it through hydration', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'example-rhetoric:latest', name: 'example-rhetoric:latest' }],
      lmstudio: [],
      sourceErrors: [],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'ollama',
      providers: [{ id: 'ollama', name: 'Ollama', enabled: true, models: [] }],
    });

    const view = render(<RhetoricTrainer {...props} config={null} />);

    expect(await screen.findByText('Loaded local models')).toBeInTheDocument();
    expect(getLoadedLlmModels).toHaveBeenCalledWith({ silent: true });
    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('ollama');
      expect(screen.getByLabelText('Model')).toHaveValue('example-rhetoric:latest');
    });

    view.rerender(<RhetoricTrainer {...props} config={{ rhetoricEvaluator: { enabled: false } }} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('ollama');
      expect(screen.getByLabelText('Model')).toHaveValue('example-rhetoric:latest');
    });
  });

  it('does not use local residency for a remote Ollama provider', async () => {
    getLoadedLlmModels.mockResolvedValueOnce({
      ollama: [{ id: 'example-rhetoric:latest', name: 'example-rhetoric:latest' }],
      lmstudio: [],
      sourceErrors: [],
    });
    getProviders.mockResolvedValueOnce({
      activeProvider: 'remote-ollama',
      providers: [{ id: 'remote-ollama', name: 'Remote Ollama', endpoint: 'http://192.0.2.10:11434/v1', enabled: true, models: [] }],
    });

    render(<RhetoricTrainer {...props} config={{ rhetoricEvaluator: { enabled: false } }} />);

    expect(await screen.findByText('Loaded local models')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Provider')).toHaveValue('');
      expect(screen.getByLabelText('Model')).toHaveValue('');
    });
    expect(screen.queryByRole('option', { name: 'example-rhetoric:latest' })).not.toBeInTheDocument();
  });

  it('shows the rhetoric exercise choices', async () => {
    render(<RhetoricTrainer {...props} />);
    await waitFor(() => expect(screen.getByText('Iambic Pentameter')).toBeInTheDocument());
    expect(screen.getByText('Diacope')).toBeInTheDocument();
    expect(screen.getByText('Chiasmus')).toBeInTheDocument();
    expect(screen.getByText('Progressia')).toBeInTheDocument();
    expect(screen.getByText('Rhetorical Brainstorm')).toBeInTheDocument();
  });

  it('requires an attempt and self-rating before advancing', async () => {
    render(<RhetoricTrainer {...props} mode="diacope" />);
    await waitFor(() => expect(screen.getByText('Prompt 1')).toBeInTheDocument());
    const save = screen.getByRole('button', { name: /save attempt/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your attempt'), { target: { value: 'Stay, until the storm passes. Stay.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 out of 5' }));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(screen.getByText('Prompt 2')).toBeInTheDocument();
  });

  it('offers a chiasmus prompt and craft checklist', async () => {
    render(<RhetoricTrainer {...props} mode="chiasmus" />);
    await waitFor(() => expect(screen.getByText('Prompt 1')).toBeInTheDocument());
    expect(screen.getByText('Chiasmus')).toBeInTheDocument();
    expect(screen.getByText(/reverses its key terms/i)).toBeInTheDocument();
    expect(screen.getByText(/reverse order/i)).toBeInTheDocument();
  });

  it('advances while evaluations are pending and saves the completed report', async () => {
    const deferred = Array.from({ length: 5 }, () => {
      let resolve;
      const promise = new Promise((finish) => { resolve = finish; });
      return { promise, resolve };
    });
    let evaluationIndex = 0;
    evaluateRhetoricAttempt.mockImplementation(() => deferred[evaluationIndex++].promise);
    const evaluation = {
      overallScore: 82,
      dimensions: ['form', 'image', 'sound'].map((id) => ({ id, score: 82, feedback: 'Specific evidence.' })),
      summary: 'A clear attempt with a deliberate image.',
      provenance: { rubricVersion: 'rhetoric-evaluator-v1', providerId: 'example-provider', model: 'example-model', effort: 'high' },
    };
    const evaluatorConfig = {
      rhetoricEvaluator: { enabled: true, providerId: 'example-provider', model: 'example-model', effort: 'high' },
    };
    render(<RhetoricTrainer {...props} mode="meter" config={evaluatorConfig} />);
    await waitFor(() => expect(screen.getByText('Prompt 1')).toBeInTheDocument());

    for (let index = 0; index < 5; index += 1) {
      fireEvent.change(screen.getByLabelText('Your attempt'), { target: { value: `Attempt ${index + 1}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Rate 4 out of 5' }));
      fireEvent.click(screen.getByRole('button', { name: /Save attempt & next/i }));
      await waitFor(() => expect(evaluateRhetoricAttempt).toHaveBeenCalledTimes(index + 1));
      if (index < 4) {
        deferred[index].resolve({ evaluation });
        await waitFor(() => expect(screen.getByText(`Prompt ${index + 2}`)).toBeInTheDocument());
      }
    }

    expect(screen.getByRole('button', { name: 'Saving report…' })).toBeDisabled();
    deferred[4].resolve({ evaluation });
    await waitFor(() => expect(submitTrainingEntry).toHaveBeenCalledTimes(1));
    const saved = submitTrainingEntry.mock.calls[0][0];
    expect(saved.scorerProvenance).toBe('post-rhetoric-self+ai');
    expect(saved.questions).toHaveLength(5);
    expect(saved.questions.every((question) => question.evaluation?.overallScore === 82)).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue POST' })).not.toBeDisabled());
  });
});
