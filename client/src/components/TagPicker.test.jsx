import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Noir' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Noir']);
  });

  it('commits a typed-but-uncommitted tag on blur (so clicking Save does not drop it)', () => {
    const onChange = vi.fn();
    render(<TagPicker value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'noir' } });
    // No Enter/comma — the user clicks elsewhere (e.g. Save), blurring the input.
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['noir']);
  });

  it('does not commit a blank input on blur', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['noir']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits the input as a tag on comma', () => {
    const onChange = vi.fn();
    render(<TagPicker value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'pulp' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith(['pulp']);
  });

  it('dedups a casing variant of an already-selected tag (no onChange)', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['Noir']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'NOIR' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('pops the last chip on Backspace with empty input', () => {
    const onChange = vi.fn();
    render(<TagPicker value={['a', 'b']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('shows autocomplete suggestions and adds one on click', async () => {
    listCatalogTags.mockResolvedValue({ items: [{ id: 'cat-tag-noir', label: 'noir', color: null }] });
    const onChange = vi.fn();
    render(<TagPicker value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'no' } });
    const suggestion = await screen.findByText('noir');
    fireEvent.mouseDown(suggestion);
    expect(onChange).toHaveBeenCalledWith(['noir']);
  });

  it('disables the input and shows a max-tags placeholder at the cap', () => {
    render(<TagPicker value={['a', 'b']} onChange={vi.fn()} maxTags={2} />);
    const input = screen.getByRole('textbox');
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('placeholder')).toMatch(/Max 2 tags/);
  });
});
