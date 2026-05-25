import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SyncBadge from './SyncBadge';

describe('SyncBadge', () => {
  it('renders "In sync" for in-parity status', () => {
    render(<SyncBadge status="in-parity" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /in sync/i })).toBeInTheDocument();
    expect(screen.getByRole('button').className).toMatch(/port-success/);
  });

  it('renders "Diverged" for diverged status', () => {
    render(<SyncBadge status="diverged" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /diverged/i })).toBeInTheDocument();
    expect(screen.getByRole('button').className).toMatch(/port-warning/);
  });

  it('renders "Assets missing" for assets-missing status', () => {
    render(<SyncBadge status="assets-missing" onClick={() => {}} />);
    expect(screen.getByText('Assets missing')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toMatch(/port-warning/);
  });

  it('renders "Local only" for local-only status', () => {
    render(<SyncBadge status="local-only" onClick={() => {}} />);
    expect(screen.getByText('Local only')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toMatch(/port-warning/);
  });

  it('renders "On peer only" for peer-only status', () => {
    render(<SyncBadge status="peer-only" onClick={() => {}} />);
    expect(screen.getByText('On peer only')).toBeInTheDocument();
    expect(screen.getByRole('button').className).toMatch(/port-warning/);
  });

  it('renders "Not syncing" with distinct neutral styling for not-syncing status', () => {
    render(<SyncBadge status="not-syncing" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: /not syncing/i });
    expect(btn).toBeInTheDocument();
    // Must not use warning or success colors — visually distinct/neutral
    expect(btn.className).not.toMatch(/port-warning/);
    expect(btn.className).not.toMatch(/port-success/);
    expect(btn.className).toMatch(/gray/);
  });

  it('renders "Sync unknown" with neutral styling for unknown status', () => {
    render(<SyncBadge status="unknown" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: /sync unknown/i });
    expect(btn).toBeInTheDocument();
    // Neutral, like not-syncing — not a warning/success state.
    expect(btn.className).not.toMatch(/port-warning/);
    expect(btn.className).not.toMatch(/port-success/);
    expect(btn.className).toMatch(/gray/);
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<SyncBadge status="in-parity" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for null status', () => {
    const { container } = render(<SyncBadge status={null} onClick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for undefined status', () => {
    const { container } = render(<SyncBadge onClick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('has a descriptive title attribute', () => {
    render(<SyncBadge status="diverged" onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn.title).toBeTruthy();
    expect(btn.title.length).toBeGreaterThan(5);
  });
});
