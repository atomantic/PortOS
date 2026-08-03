import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CityFilterBar from './CityFilterBar';

const baseFilter = { status: 'all', search: '' };

const renderBar = (props = {}) =>
  render(
    <CityFilterBar
      filter={baseFilter}
      onChange={() => {}}
      matchCount={0}
      onJumpToFirst={() => {}}
      {...props}
    />
  );

describe('CityFilterBar', () => {
  it('pressing / (not already typing) opens and focuses the search field', async () => {
    renderBar();
    // Closed by default: the search trigger button is shown, not the input.
    expect(screen.queryByLabelText('Search apps')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: '/' });

    await waitFor(() => {
      expect(screen.getByLabelText('Search apps')).toBe(document.activeElement);
    });
  });

  it('pressing Escape clears the search via onChange, with the exact cleared filter', () => {
    const onChange = vi.fn();
    renderBar({ filter: { status: 'online', search: 'alpha' }, onChange });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: 'online', search: '' });
  });

  it('pressing / while focus is already in another input does not steal focus', () => {
    render(
      <>
        <input aria-label="Unrelated field" />
        <CityFilterBar filter={baseFilter} onChange={() => {}} matchCount={0} onJumpToFirst={() => {}} />
      </>
    );
    const otherInput = screen.getByLabelText('Unrelated field');
    otherInput.focus();
    expect(document.activeElement).toBe(otherInput);

    fireEvent.keyDown(otherInput, { key: '/' });

    // Focus never moved, and the search panel never opened.
    expect(document.activeElement).toBe(otherInput);
    expect(screen.queryByLabelText('Search apps')).not.toBeInTheDocument();
  });

  it('renders filter chips with the 44px touch-target class in compact mode, not in default mode', () => {
    const { rerender } = renderBar();
    const defaultChip = screen.getByRole('button', { name: 'ALL' });
    expect(defaultChip.className).not.toContain('min-h-[44px]');

    rerender(
      <CityFilterBar
        filter={baseFilter}
        onChange={() => {}}
        matchCount={0}
        onJumpToFirst={() => {}}
        compact
      />
    );
    const compactChip = screen.getByRole('button', { name: 'ALL' });
    expect(compactChip.className).toContain('min-h-[44px]');
  });
});
