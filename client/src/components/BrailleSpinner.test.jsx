import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import BrailleSpinner from './BrailleSpinner';

const QUERY = '(prefers-reduced-motion: reduce)';
const originalMatchMedia = window.matchMedia;

let mediaQuery;

beforeEach(() => {
  vi.useFakeTimers();
  mediaQuery = {
    matches: false,
    listeners: new Set(),
    addEventListener: vi.fn((_event, listener) => mediaQuery.listeners.add(listener)),
    removeEventListener: vi.fn((_event, listener) => mediaQuery.listeners.delete(listener)),
  };
  window.matchMedia = vi.fn(() => mediaQuery);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

const glyph = (status) => status.querySelector('[aria-hidden="true"]');

describe('BrailleSpinner accessibility', () => {
  it('announces provided text while hiding the animated glyph', () => {
    render(<BrailleSpinner text="Loading records" />);

    const status = screen.getByRole('status', { name: 'Loading records' });
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Loading records')).toBeInTheDocument();
    expect(glyph(status)).toHaveAttribute('aria-hidden', 'true');
  });

  it('provides a fallback accessible loading label without visible text', () => {
    render(<BrailleSpinner />);

    const status = screen.getByRole('status', { name: 'Loading...' });
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Loading...')).toHaveClass('sr-only');
    expect(glyph(status)).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('BrailleSpinner motion preference', () => {
  it('continues advancing frames when motion is allowed', () => {
    render(<BrailleSpinner />);
    const spinnerGlyph = glyph(screen.getByRole('status'));

    expect(spinnerGlyph).toHaveTextContent('⠋');
    act(() => { vi.advanceTimersByTime(80); });
    expect(spinnerGlyph).toHaveTextContent('⠙');
  });

  it('freezes at the first frame when reduced motion is preferred', () => {
    mediaQuery.matches = true;
    render(<BrailleSpinner />);
    const spinnerGlyph = glyph(screen.getByRole('status'));

    expect(window.matchMedia).toHaveBeenCalledWith(QUERY);
    expect(spinnerGlyph).toHaveTextContent('⠋');
    act(() => { vi.advanceTimersByTime(240); });
    expect(spinnerGlyph).toHaveTextContent('⠋');
  });

  it('stops and resets when the preference changes while mounted', () => {
    render(<BrailleSpinner />);
    const spinnerGlyph = glyph(screen.getByRole('status'));

    act(() => { vi.advanceTimersByTime(80); });
    expect(spinnerGlyph).toHaveTextContent('⠙');

    act(() => {
      mediaQuery.matches = true;
      mediaQuery.listeners.forEach(listener => listener());
    });
    expect(spinnerGlyph).toHaveTextContent('⠋');

    act(() => { vi.advanceTimersByTime(240); });
    expect(spinnerGlyph).toHaveTextContent('⠋');
  });
});
