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

describe('EntryCard — layout', () => {
  // Smallest ancestor of `from` that also holds `other` — containment rather
  // than a hop count, so the assertion survives a re-nesting that keeps the
  // layout.
  const smallestCommonAncestor = (from, other) => {
    let node = from;
    while (node && !node.contains(other)) node = node.parentElement;
    return node;
  };

  it('keeps actions inside the content column, on the title row', () => {
    render(wrapInList(
      <EntryCard
        title={<span>Lyra</span>}
        body={<p>a description</p>}
        actions={<button type="button">Edit</button>}
      />,
    ));
    const edit = screen.getByRole('button', { name: 'Edit' });
    const body = screen.getByText('a description');
    // Regression: `actions` used to be a sibling column of the content column,
    // squeezing `body` to a third of a phone-width card.
    expect(body.parentElement).toContainElement(edit);
    // ...and it shares the title's row, so `body` still spans the full column.
    expect(smallestCommonAncestor(edit, screen.getByText('Lyra')))
      .not.toContainElement(body);
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
    expect(img.getAttribute('src')).toBe('/data/image-thumbnails/render-3.webp');
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
    // Each filename tries its small WebP derivative, then its original.
    const srcAfterErrors = (n) => {
      for (let i = 0; i < n; i += 1) fireEvent.error(container.querySelector('img'));
      return container.querySelector('img').getAttribute('src');
    };
    expect(srcAfterErrors(0)).toBe('/data/image-thumbnails/newest.webp');
    expect(srcAfterErrors(1)).toBe('/data/images/newest.png');
    expect(srcAfterErrors(1)).toBe('/data/image-thumbnails/middle.webp');
    expect(srcAfterErrors(2)).toBe('/data/image-thumbnails/oldest.webp');
    expect(srcAfterErrors(1)).toBe('/data/images/oldest.png');
  });

  it('collapses to nothing when every candidate fails to load', () => {
    const { container } = render(wrapInList(
      <EntryCard
        title={<div>L1</div>}
        thumbnail={{ filename: 'only.png', alt: 'avatar', fallbackRefs: [] }}
      />,
    ));
    fireEvent.error(container.querySelector('img'));
    fireEvent.error(container.querySelector('img'));
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
    // A failed thumbnail retries the same file's original, still the newest.
    fireEvent.error(container.querySelector('img'));
    fireEvent.click(container.querySelector('button'));
    expect(onClick).toHaveBeenLastCalledWith('newest.png');
    // After the newest original fails too, the click previews the fallback.
    fireEvent.error(container.querySelector('img'));
    fireEvent.click(container.querySelector('button'));
    expect(onClick).toHaveBeenLastCalledWith('old.png');
  });
});
