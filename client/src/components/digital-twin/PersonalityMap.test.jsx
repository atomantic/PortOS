import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiDigitalTwin.js', () => ({
  analyzeDigitalTwinTraits: vi.fn(() => Promise.resolve({}))
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import PersonalityMap from './PersonalityMap';
import { analyzeDigitalTwinTraits } from '../../services/apiDigitalTwin.js';
import toast from '../ui/Toast';

const PROVIDERS = [
  { id: 'example-provider', name: 'Example Provider', type: 'api', enabled: true, defaultModel: 'example-model', models: [] }
];
const OLLAMA = [
  { id: 'ollama', name: 'Ollama', type: 'api', enabled: true, defaultModel: 'llama3.1:8b', models: ['llama3.1:8b', 'qwen3:4b'] }
];
const TRAITS = { bigFive: { O: 0.6, C: 0.5, E: 0.4, A: 0.7, N: 0.3 }, lastAnalyzed: '2026-01-01T00:00:00Z' };

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('PersonalityMap provider picker', () => {
  it('labels the provider/model select so screen readers announce it', () => {
    render(<PersonalityMap traits={null} confidence={null} providers={PROVIDERS} />);
    const select = screen.getByRole('combobox', { name: 'AI Provider & Model' });
    expect(select).toHaveValue('example-provider');
  });

  it('Reanalyze uses the default provider when providers arrive after mount', async () => {
    const { rerender } = render(<PersonalityMap traits={TRAITS} confidence={null} providers={[]} />);
    rerender(<PersonalityMap traits={TRAITS} confidence={null} providers={PROVIDERS} />);
    fireEvent.click(screen.getByText('Show Details'));
    expect(screen.getByRole('combobox', { name: 'AI Provider & Model' })).toBeTruthy();
    fireEvent.click(screen.getByText('Reanalyze Traits'));
    await waitFor(() => expect(analyzeDigitalTwinTraits).toHaveBeenCalled());
    expect(analyzeDigitalTwinTraits).toHaveBeenCalledWith('example-provider', 'example-model', true, { silent: true });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('Analyze Traits (empty state) works after async provider load', async () => {
    const { rerender } = render(<PersonalityMap traits={null} confidence={null} providers={[]} />);
    rerender(<PersonalityMap traits={null} confidence={null} providers={PROVIDERS} />);
    fireEvent.click(screen.getByText('Analyze Traits'));
    await waitFor(() => expect(analyzeDigitalTwinTraits).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps colon-containing model ids intact when picking a model', async () => {
    render(<PersonalityMap traits={null} confidence={null} providers={OLLAMA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'qwen3:4b' } });
    fireEvent.click(screen.getByText('Analyze Traits'));
    await waitFor(() => expect(analyzeDigitalTwinTraits).toHaveBeenCalled());
    expect(analyzeDigitalTwinTraits).toHaveBeenCalledWith('ollama', 'qwen3:4b', true, { silent: true });
  });
});
