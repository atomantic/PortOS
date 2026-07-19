import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ProviderModelSelector from './ProviderModelSelector';

const PROVIDERS = [
  { id: 'p1', name: 'Provider One' },
  { id: 'p2', name: 'Provider Two' },
];

function renderSelector(props = {}) {
  return render(
    <ProviderModelSelector
      providers={PROVIDERS}
      selectedProviderId="p1"
      selectedModel="m1"
      availableModels={['m1', 'm2']}
      onProviderChange={() => {}}
      onModelChange={() => {}}
      {...props}
    />
  );
}

describe('ProviderModelSelector', () => {
  it('renders only the provider options by default (no empty sentinel)', () => {
    renderSelector();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Provider One', 'Provider Two', 'm1', 'm2']);
  });

  it('prepends empty options with value "" when emptyProviderOption/emptyModelOption are set', () => {
    renderSelector({ emptyProviderOption: 'Use default', emptyModelOption: 'Default model' });
    const providerSelect = screen.getAllByRole('combobox')[0];
    const firstProviderOption = providerSelect.querySelector('option');
    expect(firstProviderOption.value).toBe('');
    expect(firstProviderOption.textContent).toBe('Use default');

    const modelSelect = screen.getAllByRole('combobox')[1];
    const firstModelOption = modelSelect.querySelector('option');
    expect(firstModelOption.value).toBe('');
    expect(firstModelOption.textContent).toBe('Default model');
  });

  it('hides the model select when availableModels is empty (default)', () => {
    renderSelector({ availableModels: [] });
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('renders the model select even when empty if alwaysShowModel is set', () => {
    renderSelector({ availableModels: [], alwaysShowModel: true, emptyModelOption: 'Default model' });
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(2);
    expect(combos[1].querySelector('option').textContent).toBe('Default model');
  });

  it('normalizes object-shaped model entries to value/label', () => {
    renderSelector({
      availableModels: [{ id: 'mid', name: 'Pretty Name' }, { id: 'bare' }],
      selectedModel: 'mid',
    });
    const modelSelect = screen.getAllByRole('combobox')[1];
    const opts = [...modelSelect.querySelectorAll('option')];
    expect(opts.map((o) => o.value)).toEqual(['mid', 'bare']);
    // `{ id }` with no name falls back to the id as the label.
    expect(opts.map((o) => o.textContent)).toEqual(['Pretty Name', 'bare']);
  });

  it('skips nullish model entries instead of crashing (sparse/empty provider list)', () => {
    // useProviderModels can pass `[undefined]` for a provider with no models;
    // modelOption must tolerate it and the map must skip it.
    expect(() =>
      renderSelector({ availableModels: [undefined, 'm2', null], alwaysShowModel: true })
    ).not.toThrow();
    const modelSelect = screen.getAllByRole('combobox')[1];
    expect([...modelSelect.querySelectorAll('option')].map((o) => o.value)).toEqual(['m2']);
  });

  it('fires onProviderChange/onModelChange with the selected value', () => {
    const onProviderChange = vi.fn();
    const onModelChange = vi.fn();
    renderSelector({ onProviderChange, onModelChange });
    const [providerSelect, modelSelect] = screen.getAllByRole('combobox');
    fireEvent.change(providerSelect, { target: { value: 'p2' } });
    expect(onProviderChange).toHaveBeenCalledWith('p2');
    fireEvent.change(modelSelect, { target: { value: 'm2' } });
    expect(onModelChange).toHaveBeenCalledWith('m2');
  });

  it('filters out disabled providers from the dropdown', () => {
    renderSelector({
      providers: [
        { id: 'p1', name: 'Provider One' },
        { id: 'p2', name: 'Provider Two', enabled: false },
        { id: 'p3', name: 'Provider Three', enabled: true },
      ],
    });
    const providerSelect = screen.getAllByRole('combobox')[0];
    const labels = [...providerSelect.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['Provider One', 'Provider Three']);
  });

  it('keeps a disabled provider visible when it is the current selection', () => {
    renderSelector({
      selectedProviderId: 'p2',
      providers: [
        { id: 'p1', name: 'Provider One' },
        { id: 'p2', name: 'Provider Two', enabled: false },
      ],
    });
    const providerSelect = screen.getAllByRole('combobox')[0];
    const labels = [...providerSelect.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toEqual(['Provider One', 'Provider Two']);
  });

  it('stacks the selects vertically when layout="stacked"', () => {
    const { container } = renderSelector({ layout: 'stacked' });
    expect(container.firstChild.className).toContain('flex-col');
  });

  describe('highlightToolUse (agent pickers)', () => {
    const OLLAMA = [{ id: 'ollama', name: 'Ollama' }];

    it('marks local model options with a tool-use indicator', () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'qwen3.6:35b',
        availableModels: ['qwen3.6:35b', 'gemma4:e4b'],
        highlightToolUse: true,
      });
      const labels = [...screen.getAllByRole('combobox')[1].querySelectorAll('option')].map((o) => o.textContent);
      expect(labels).toEqual(['qwen3.6:35b · 🔧 tool use', 'gemma4:e4b · ⚠ no known tool use']);
    });

    it('warns when the selected LOCAL model cannot call tools', () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'gemma4:e4b',
        availableModels: ['qwen3.6:35b', 'gemma4:e4b'],
        highlightToolUse: true,
      });
      expect(screen.getByText(/recognized tool-calling model/i)).toBeInTheDocument();
    });

    it('warns on the provider default when the model selection is blank', () => {
      // "Default model" (blank) isn't a no-op — the resolver runs the provider's
      // defaultModel, which here is a non-tool local model.
      renderSelector({
        providers: [{ id: 'ollama', name: 'Ollama', defaultModel: 'gemma4:e4b' }],
        selectedProviderId: 'ollama',
        selectedModel: '',
        availableModels: ['qwen3.6:35b', 'gemma4:e4b'],
        alwaysShowModel: true,
        emptyModelOption: 'Default model',
        highlightToolUse: true,
      });
      expect(screen.getByText(/recognized tool-calling model/i)).toBeInTheDocument();
    });

    it('does not warn when the selected local model is tool-capable', () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'qwen3.6:35b',
        availableModels: ['qwen3.6:35b', 'gemma4:e4b'],
        highlightToolUse: true,
      });
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
    });

    it('is a no-op for cloud providers (ids do not encode family)', () => {
      renderSelector({
        providers: [{ id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' }],
        selectedProviderId: 'openai',
        selectedModel: 'gpt-4o',
        availableModels: ['gpt-4o', 'o1'],
        highlightToolUse: true,
      });
      const labels = [...screen.getAllByRole('combobox')[1].querySelectorAll('option')].map((o) => o.textContent);
      expect(labels).toEqual(['gpt-4o', 'o1']);
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
    });

    it('leaves options unannotated when highlightToolUse is off (default)', () => {
      renderSelector({
        providers: OLLAMA,
        selectedProviderId: 'ollama',
        selectedModel: 'gemma4:e4b',
        availableModels: ['qwen3.6:35b', 'gemma4:e4b'],
      });
      const labels = [...screen.getAllByRole('combobox')[1].querySelectorAll('option')].map((o) => o.textContent);
      expect(labels).toEqual(['qwen3.6:35b', 'gemma4:e4b']);
      expect(screen.queryByText(/recognized tool-calling model/i)).not.toBeInTheDocument();
    });
  });
});
