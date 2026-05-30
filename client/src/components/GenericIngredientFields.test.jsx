import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// TagPicker + IngredientPicker are exercised elsewhere; stub them to keep this
// focused on the generic field dispatch + payload read/write.
vi.mock('./TagPicker', () => ({
  default: ({ id, value, onChange }) => (
    <button type="button" data-testid={`tagpicker-${id}`} onClick={() => onChange([...(value || []), 'added'])}>
      tags:{(value || []).join('|')}
    </button>
  ),
}));
vi.mock('./IngredientPicker', () => ({
  default: ({ open, onSelect }) => (open ? (
    <button type="button" data-testid="ingredientpicker" onClick={() => onSelect({ id: 'cat-chr-99' })}>pick</button>
  ) : null),
}));

import GenericIngredientFields from './GenericIngredientFields';

const fields = [
  { key: 'motto', label: 'Motto', widget: 'text' },
  { key: 'creed', label: 'Creed', widget: 'textarea' },
  { key: 'aliases', label: 'Aliases', widget: 'tags' },
  { key: 'leader', label: 'Leader', widget: 'ref' },
];

describe('GenericIngredientFields', () => {
  it('renders a labeled widget per field with htmlFor/id pairing', () => {
    render(<GenericIngredientFields fields={fields} payload={{}} onChange={() => {}} />);
    // Label/id pairing — getByLabelText resolves only when wired.
    expect(screen.getByLabelText('Motto')).toBeTruthy();
    expect(screen.getByLabelText('Creed').tagName).toBe('TEXTAREA');
  });

  it('writes payload[key] for text + textarea fields', () => {
    const onChange = vi.fn();
    render(<GenericIngredientFields fields={fields} payload={{}} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Motto'), { target: { value: 'unity' } });
    expect(onChange).toHaveBeenCalledWith('motto', 'unity');
  });

  it('routes tags through the tag widget', () => {
    const onChange = vi.fn();
    render(<GenericIngredientFields fields={fields} payload={{ aliases: ['a'] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('tagpicker-ingredient-aliases'));
    expect(onChange).toHaveBeenCalledWith('aliases', ['a', 'added']);
  });

  it('stores a picked ingredient id for a ref field', () => {
    const onChange = vi.fn();
    render(<GenericIngredientFields fields={fields} payload={{}} onChange={onChange} />);
    // Open the picker via the field's Link button, then select.
    fireEvent.click(screen.getByRole('button', { name: /Link/i }));
    fireEvent.click(screen.getByTestId('ingredientpicker'));
    expect(onChange).toHaveBeenCalledWith('leader', 'cat-chr-99');
  });

  it('shows an empty-state hint when the type has no fields', () => {
    render(<GenericIngredientFields fields={[]} payload={{}} onChange={() => {}} />);
    expect(screen.getByText(/no fields yet/i)).toBeTruthy();
  });
});
