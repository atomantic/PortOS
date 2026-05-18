import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EntryCard from './EntryCard';

const wrapInList = (node) => <ul>{node}</ul>;

describe('EntryCard — selectable mode', () => {
  it('omits the checkbox entirely when selectable is null', () => {
    render(wrapInList(
      <EntryCard title={<div>Lyra</div>} body={<p>desc</p>} />,
    ));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a checkbox bound to selectable.selected', () => {
    render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: true, onToggle: () => {}, label: 'Include Lyra' }}
      />,
    ));
    const cb = screen.getByRole('checkbox', { name: 'Include Lyra' });
    expect(cb).toBeChecked();
  });

  it('fires onToggle when the checkbox is clicked', () => {
    const onToggle = vi.fn();
    render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: false, onToggle, label: 'Include Lyra' }}
      />,
    ));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Lyra' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('applies the selected accent classes when selected', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: true, onToggle: () => {}, label: 'Include Lyra' }}
      />,
    ));
    const li = container.querySelector('li');
    expect(li.className).toMatch(/border-port-accent/);
    expect(li.className).toMatch(/bg-port-accent\/5/);
    expect(li.className).not.toMatch(/opacity-60/);
  });

  it('applies the unselected dim classes when not selected', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: false, onToggle: () => {}, label: 'Include Lyra' }}
      />,
    ));
    const li = container.querySelector('li');
    expect(li.className).toMatch(/opacity-60/);
    expect(li.className).toMatch(/border-port-border/);
  });

  it('falls back to a generic checkbox label when selectable.label is omitted', () => {
    render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: false, onToggle: () => {} }}
      />,
    ));
    expect(screen.getByRole('checkbox', { name: 'Select entry' })).toBeInTheDocument();
  });

  it('clicking the padded card area (outside the checkbox) toggles selection', () => {
    const onToggle = vi.fn();
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: false, onToggle, label: 'Include Lyra' }}
      />,
    ));
    // The overlay label spans the entire padded card surface — clicking it
    // (not the checkbox itself) must still toggle.
    const overlay = container.querySelector('label');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps action buttons outside the checkbox label so they remain independently clickable', () => {
    const onToggle = vi.fn();
    const onAction = vi.fn();
    render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: false, onToggle, label: 'Include Lyra' }}
        actions={<button onClick={onAction}>Edit</button>}
      />,
    ));
    // Sanity: the button is NOT nested inside the <label> (invalid HTML).
    const button = screen.getByRole('button', { name: 'Edit' });
    expect(button.closest('label')).toBeNull();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('uses p-3 padding in selectable mode to match the pre-extract Importer card', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>Lyra</div>}
        selectable={{ selected: false, onToggle: () => {} }}
      />,
    ));
    const li = container.querySelector('li');
    expect(li.className).toMatch(/(^|\s)p-3(\s|$)/);
  });
});

describe('EntryCard — thumbnail fallback', () => {
  it('renders the primary filename when present', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>L1</div>}
        thumbnail={{ filename: 'render-3.png', alt: 'avatar' }}
      />,
    ));
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe('/data/images/render-3.png');
  });

  it('walks back through fallbackRefs on image error', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>L1</div>}
        thumbnail={{
          filename: 'newest.png',
          alt: 'avatar',
          // chronological: oldest first, newest last. The `filename` field
          // already holds the newest, so the walk-back order is
          // newest → middle → oldest.
          fallbackRefs: ['oldest.png', 'middle.png', 'newest.png'],
        }}
      />,
    ));
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe('/data/images/newest.png');
    fireEvent.error(img);
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/middle.png');
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/oldest.png');
  });

  it('collapses to nothing when every candidate fails to load', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>L1</div>}
        thumbnail={{ filename: 'only.png', alt: 'avatar', fallbackRefs: [] }}
      />,
    ));
    const img = container.querySelector('img');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
  });

  it('passes the currently displayed filename to onClick', () => {
    const onClick = vi.fn();
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>L1</div>}
        thumbnail={{
          filename: 'newest.png',
          alt: 'avatar',
          fallbackRefs: ['old.png', 'newest.png'],
          onClick,
        }}
      />,
    ));
    // Initial click previews the newest visible filename.
    fireEvent.click(container.querySelector('button'));
    expect(onClick).toHaveBeenLastCalledWith('newest.png');
    // After the newest fails, the click should preview the now-visible fallback.
    fireEvent.error(container.querySelector('img'));
    fireEvent.click(container.querySelector('button'));
    expect(onClick).toHaveBeenLastCalledWith('old.png');
  });
});
