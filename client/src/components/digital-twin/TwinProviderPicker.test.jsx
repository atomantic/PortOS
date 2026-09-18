import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import TwinProviderPicker from './TwinProviderPicker.jsx';

afterEach(cleanup);

const PROVIDERS = [
  { id: 'lmstudio', name: 'LM Studio', type: 'api', enabled: true, models: ['qwen', 'llama'], defaultModel: 'llama' },
  { id: 'ollama', name: 'Ollama', type: 'api', enabled: true, models: [], defaultModel: 'gemma' },
];

describe('TwinProviderPicker', () => {
  it('keeps the {providerId, model} shape: a provider change seeds its default model, a model change keeps the provider', () => {
    const onChange = vi.fn();
    render(<TwinProviderPicker providers={PROVIDERS} selected={{ providerId: 'lmstudio', model: 'qwen' }} onChange={onChange} label="Analyze with" />);
    const provider = screen.getByRole('combobox', { name: 'Analyze with' });
    const model = screen.getByRole('combobox', { name: 'Model' });
    expect(provider.value).toBe('lmstudio');
    expect([...model.options].map((o) => o.value)).toEqual(['qwen', 'llama']);
    fireEvent.change(model, { target: { value: 'llama' } });
    expect(onChange).toHaveBeenLastCalledWith({ providerId: 'lmstudio', model: 'llama' });
    fireEvent.change(provider, { target: { value: 'ollama' } });
    expect(onChange).toHaveBeenLastCalledWith({ providerId: 'ollama', model: 'gemma' });
  });

  it('renders an unseeded selection without a model select and no crash', () => {
    render(<TwinProviderPicker providers={PROVIDERS} selected={null} onChange={() => {}} compact />);
    // A required select with no matching value shows its first option (same as the old combined select).
    expect(screen.getByRole('combobox', { name: 'AI provider' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
});
