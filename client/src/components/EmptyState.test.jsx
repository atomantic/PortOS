import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

  it('renders no action element when only a label is given', () => {
    const { container } = renderWithRouter(<EmptyState message="msg" actionLabel="Nowhere" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
