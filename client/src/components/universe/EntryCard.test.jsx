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
});
