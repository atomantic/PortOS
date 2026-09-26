import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeckLlmPinPicker from './DeckLlmPinPicker';

const providers = [{ id: 'codex', name: 'Codex', type: 'cli', command: 'codex', defaultModel: 'example-model' }];
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => {
    const [selectedProviderId, setSelectedProviderId] = useState('');
    const [selectedModel, setSelectedModel] = useState('');
    return { providers, selectedProviderId, setSelectedProviderId, selectedModel, setSelectedModel, availableModels: ['example-model'], loading: false };
  },
}));

function Picker({ onChange, initialPin = null }) {
  const [pin, setPin] = useState(initialPin);
  return <DeckLlmPinPicker pin={pin} onChange={(next) => { onChange(next); setPin(next); }} />;
}

describe('DeckLlmPinPicker API payload', () => {
  it('uses null for default dimensions when selecting and clearing a provider', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Prompt model' }), { target: { value: 'codex' } });
    expect(onChange).toHaveBeenLastCalledWith({ providerId: 'codex', model: null, effort: null });
    fireEvent.change(screen.getByRole('combobox', { name: 'Prompt model' }), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ providerId: null, model: null, effort: null });
  });

  it('preserves explicit choices and sends null when effort returns to default', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} initialPin={{ providerId: 'codex', model: 'example-model', effort: 'high' }} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking effort' }), { target: { value: 'low' } });
    expect(onChange).toHaveBeenLastCalledWith({ providerId: 'codex', model: 'example-model', effort: 'low' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking effort' }), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ providerId: 'codex', model: 'example-model', effort: null });
  });
});
