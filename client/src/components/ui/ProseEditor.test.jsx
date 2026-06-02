import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import ProseEditor from './ProseEditor';

describe('ProseEditor', () => {
  it('renders a serif, relaxed-leading, spellchecked textarea', () => {
    render(<ProseEditor value="hello" onChange={() => {}} />);
    const ta = screen.getByRole('textbox');
    expect(ta.className).toContain('font-serif');
    expect(ta.className).toContain('leading-relaxed');
    expect(ta.getAttribute('spellcheck')).toBe('true');
    expect(ta.value).toBe('hello');
  });

  it('uses the heading-hint placeholder by default and lets callers override it', () => {
    const { rerender } = render(<ProseEditor value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText(/# Chapter, ## Scene, ### Beat/)).toBeTruthy();
    rerender(<ProseEditor value="" onChange={() => {}} placeholder="Draft here" />);
    expect(screen.getByPlaceholderText('Draft here')).toBeTruthy();
  });

  it('does not bake in focus:outline-none (focus treatment is the caller’s)', () => {
    // A shared primitive must not silently strip the focus outline — bordered
    // callers rely on the browser default unless they opt into their own ring.
    render(<ProseEditor value="" onChange={() => {}} />);
    expect(screen.getByRole('textbox').className).not.toContain('outline-none');
  });

  it('forwards onChange events', () => {
    const onChange = vi.fn();
    render(<ProseEditor value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('merges passthrough className after the baked-in prose classes', () => {
    render(<ProseEditor value="" onChange={() => {}} className="w-full px-6 text-base" />);
    const ta = screen.getByRole('textbox');
    expect(ta.className).toContain('font-serif');
    expect(ta.className).toContain('w-full');
    expect(ta.className).toContain('text-base');
  });

  it('forwards arbitrary textarea props (rows) and a ref', () => {
    const ref = createRef();
    render(<ProseEditor ref={ref} value="" onChange={() => {}} rows={24} />);
    const ta = screen.getByRole('textbox');
    expect(ta.getAttribute('rows')).toBe('24');
    expect(ref.current).toBe(ta);
  });

  it('paints the paper background only for the light reading theme', () => {
    const { rerender } = render(<ProseEditor value="" onChange={() => {}} readingTheme="light" />);
    let ta = screen.getByRole('textbox');
    expect(ta.style.getPropertyValue('--port-input-bg')).toBe('var(--wr-reading-paper)');

    rerender(<ProseEditor value="" onChange={() => {}} readingTheme="dark" />);
    ta = screen.getByRole('textbox');
    expect(ta.style.getPropertyValue('--port-input-bg')).toBe('');
  });

  it('allows spellCheck to be disabled', () => {
    render(<ProseEditor value="" onChange={() => {}} spellCheck={false} />);
    expect(screen.getByRole('textbox').getAttribute('spellcheck')).toBe('false');
  });
});
