import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LinkChip from './LinkChip';

const link = { id: 'l1', url: 'https://www.example.com/docs', title: 'Example Docs' };

describe('LinkChip', () => {
  it('renders the title and a favicon img derived from the hostname', () => {
    const { container } = render(<LinkChip link={link} />);
    expect(screen.getByText('Example Docs')).toBeTruthy();
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toContain('example.com');
  });

  it('opens the link in a new tab', () => {
    render(<LinkChip link={link} />);
    const anchor = screen.getByText('Example Docs').closest('a');
    expect(anchor.getAttribute('href')).toBe(link.url);
    expect(anchor.getAttribute('target')).toBe('_blank');
  });

  it('falls back to the link icon when the favicon fails to load', () => {
    const { container } = render(<LinkChip link={link} />);
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelector('img')).toBeNull();
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    render(<LinkChip link={link} onRemove={onRemove} />);
    fireEvent.click(screen.getByTitle('Remove from bucket'));
    expect(onRemove).toHaveBeenCalledWith(link);
  });

  it('renders no drag handle when dragHandleProps is omitted', () => {
    render(<LinkChip link={link} />);
    expect(screen.queryByLabelText(/Drag /)).toBeNull();
  });

  it('renders a named, focusable drag handle when dragHandleProps is supplied', () => {
    render(<LinkChip link={link} dragHandleProps={{ attributes: {}, listeners: {}, setActivatorNodeRef: () => {} }} />);
    const handle = screen.getByLabelText('Drag Example Docs');
    expect(handle.tagName).toBe('BUTTON');
  });
});
