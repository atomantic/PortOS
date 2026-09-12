import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { act, render, screen, fireEvent } from '@testing-library/react';

vi.mock('../services/apiCatalog', () => ({
  listCatalogTags: vi.fn(),
}));

import TagPicker from './TagPicker';
import { listCatalogTags } from '../services/apiCatalog';

beforeEach(() => {
  vi.clearAllMocks();
  listCatalogTags.mockResolvedValue({ items: [] });
});

describe('TagPicker', () => {
  it('renders existing tags as removable chips', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['noir', 'pulp']} onChange={onChange} />);
    expect(screen.getByText('noir')).toBeTruthy();
    expect(screen.getByText('pulp')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove tag noir'));
    expect(onChange).toHaveBeenCalledWith(['pulp']);
  });

  it('commits the input as a tag on Enter', () => {
    const onChange = vi.fn();
    render(<TagPicker id="tp" value={[]} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Noir' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Noir']);
  });

  it('commits a typed-but-uncommitted tag on blur (so clicking Save does not drop it)', () => {
    const onChange = vi.fn();
    render(<TagPicker value={[]} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'noir' } });
    // No Enter/comma — the user clicks elsewhere (e.g. Save), blurring the input.
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['noir']);
  });

  it('does not commit a blank input on blur', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['noir']} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits the input as a tag on comma', () => {
    const onChange = vi.fn();
    render(<TagPicker value={[]} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'pulp' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith(['pulp']);
  });

  it('dedups a casing variant of an already-selected tag (no onChange)', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['Noir']} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'NOIR' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('pops the last chip on Backspace with empty input', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['a', 'b']} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('shows autocomplete suggestions and adds one on click', async () => {
    listCatalogTags.mockResolvedValue({ items: [{ id: 'cat-tag-noir', label: 'noir', color: null }] });
    const onChange = vi.fn();
    render(<TagPicker value={[]} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'no' } });
    const suggestion = await screen.findByText('noir');
    fireEvent.click(suggestion);
    expect(onChange).toHaveBeenCalledWith(['noir']);
  });

  it('disables the input and shows a max-tags placeholder at the cap', () => {
    render(<TagPicker value={['a', 'b']} onChange={vi.fn()} maxTags={2} />);
    const input = screen.getByRole('combobox');
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('placeholder')).toMatch(/Max 2 tags/);
  });
});

function ControlledPicker(props) {
  const [value, setValue] = useState(props.value ?? []);
  return <>
    <label htmlFor="tags">Tags</label>
    <TagPicker {...props} id="tags" value={value} onChange={(next) => { setValue(next); props.onChange?.(next); }} />
    <button type="button">Save</button>
  </>;
}

describe('TagPicker combobox interactions', () => {
  const items = [{ id: 'example', label: 'Example tag' }, { id: 'extra', label: 'Extra tag' }];

  it('navigates, dismisses without changing text, and commits the canonical label once', async () => {
    listCatalogTags.mockResolvedValue({ items });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'Ex');
    const list = await screen.findByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: 'Extra tag' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(input.value).toBe('Ex');
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Example tag' }).id);
    await user.keyboard('{Enter}');
    await user.tab();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['Example tag']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('preserves internal focus moves and supports click without mousedown', async () => {
    listCatalogTags.mockResolvedValue({ items });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker value={['Existing']} onChange={onChange} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'Ex');
    const option = await screen.findByRole('option', { name: 'Example tag' });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove tag Existing' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
    act(() => option.focus());
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(option);
    expect(document.activeElement).toBe(input);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['Existing', 'Example tag']);
  });

  it('tabs past suggestions and commits normalized pending input before Save', async () => {
    listCatalogTags.mockResolvedValue({ items });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} maxTagChars={10} />);
    await user.type(screen.getByRole('combobox'), ' Ex  tag ');
    await screen.findByRole('listbox');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['Ex tag']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('removes active relationships when a parent selects the active option', async () => {
    listCatalogTags.mockResolvedValue({ items });
    const view = render(<TagPicker value={[]} onChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Ex' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    view.rerender(<TagPicker value={['Example tag']} onChange={vi.fn()} />);
    expect(screen.queryByRole('option', { name: 'Example tag' })).toBeNull();
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Extra tag' }).id);
  });

  it('rejects an in-flight response after input is cleared', async () => {
    let resolveLater;
    listCatalogTags.mockImplementation(() => new Promise((resolve) => { resolveLater = resolve; }));
    render(<TagPicker value={[]} onChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Ex' } });
    await vi.waitFor(() => expect(resolveLater).toBeTypeOf('function'));
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => resolveLater({ items }));
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
});
