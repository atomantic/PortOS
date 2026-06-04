import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ModelSelect from './ModelSelect';

const MODELS = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'old', name: 'Legacy One', deprecated: true },
];

function renderSelect(props = {}) {
  return render(
    <ModelSelect models={MODELS} value="a" onChange={() => {}} {...props} />
  );
}

describe('ModelSelect', () => {
  it('renders active options and a Legacy optgroup for deprecated models', () => {
    renderSelect();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Alpha', 'Beta', 'Legacy One']);
    // The deprecated model lives under a labelled <optgroup>.
    const optgroup = document.querySelector('optgroup');
    expect(optgroup?.label).toBe('Legacy');
  });

  it('omits the Legacy optgroup when no model is deprecated', () => {
    renderSelect({ models: [{ id: 'a', name: 'Alpha' }] });
    expect(document.querySelector('optgroup')).toBeNull();
  });

  it('prepends an empty option with value "" when emptyOption is set', () => {
    renderSelect({ emptyOption: 'Default model', value: '' });
    const first = screen.getByRole('combobox').querySelector('option');
    expect(first.value).toBe('');
    expect(first.textContent).toBe('Default model');
  });

  it('falls back through getLabel when a model omits name', () => {
    renderSelect({ models: [{ id: 'no-name' }], value: 'no-name', getLabel: (m) => m.name || m.id });
    expect(screen.getByRole('option').textContent).toBe('no-name');
  });

  it('applies ariaLabel and forwards change events', () => {
    const onChange = vi.fn();
    renderSelect({ ariaLabel: 'Video model', onChange });
    const select = screen.getByLabelText('Video model');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
