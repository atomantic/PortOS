import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import EmptyState from './EmptyState';

const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('EmptyState', () => {
  it('renders the title and teaching message', () => {
    renderWithRouter(
      <EmptyState title="No providers configured" message="Configure one provider to enable CoS." />
    );
    expect(screen.getByText('No providers configured')).toBeTruthy();
    expect(screen.getByText('Configure one provider to enable CoS.')).toBeTruthy();
  });

  it('renders a route Link when actionTo + actionLabel are provided', () => {
    renderWithRouter(
      <EmptyState message="msg" actionTo="/calendar/config" actionLabel="Connect Calendar" />
    );
    const link = screen.getByText('Connect Calendar').closest('a');
    expect(link.getAttribute('href')).toBe('/calendar/config');
  });

  it('renders a button and fires onAction instead of a Link', () => {
    const onAction = vi.fn();
    renderWithRouter(
      <EmptyState message="msg" actionLabel="Add Provider" onAction={onAction} actionTo="/ignored" />
    );
    const btn = screen.getByText('Add Provider');
    expect(btn.tagName).toBe('BUTTON');
    expect(screen.queryByText('Add Provider').closest('a')).toBeNull();
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('exposes the actionTo call to action as a link with an accessible name', () => {
    renderWithRouter(
      <EmptyState title="No boards yet" message="msg" actionTo="/mood-boards/new" actionLabel="Create your first board" />
    );
    // Role + name is the contract the converted index pages assert against —
    // a conversion that drops actionLabel leaves a dead-end empty state.
    const link = screen.getByRole('link', { name: 'Create your first board' });
    expect(link.getAttribute('href')).toBe('/mood-boards/new');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('exposes the onAction call to action as a button with an accessible name', () => {
    const onAction = vi.fn();
    renderWithRouter(
      <EmptyState title="No sprites yet" message="msg" actionLabel="Create your first sprite" onAction={onAction} />
    );
    const btn = screen.getByRole('button', { name: 'Create your first sprite' });
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders no action element when only a label is given', () => {
    const { container } = renderWithRouter(<EmptyState message="msg" actionLabel="Nowhere" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
