import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import ProgressBar, { clampPercent } from './ProgressBar.jsx';

// The fill is the only child of the track, and it carries no role of its own.
const fillOf = (container) => container.querySelector('[role="progressbar"] > div');

describe('ProgressBar', () => {
  it('always emits the ARIA trio plus an accessible name', () => {
    render(<ProgressBar percent={42} label="Download progress" />);
    const bar = screen.getByRole('progressbar', { name: 'Download progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('names the bar even when the host forgets a label', () => {
    render(<ProgressBar percent={10} />);
    expect(screen.getByRole('progressbar', { name: 'Progress' })).toBeInTheDocument();
  });

  it('sizes the fill to the percentage', () => {
    const { container } = render(<ProgressBar percent={37.5} label="x" />);
    expect(fillOf(container)).toHaveStyle({ width: '37.5%' });
  });

  it.each([
    ['over 100', 140, '100%', '100'],
    ['below zero', -20, '0%', '0'],
  ])('clamps a percentage %s', (_label, percent, width, valuenow) => {
    const { container } = render(<ProgressBar percent={percent} label="x" />);
    expect(fillOf(container)).toHaveStyle({ width });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', valuenow);
  });

  it('rounds aria-valuenow but keeps the fractional width', () => {
    const { container } = render(<ProgressBar percent={33.333} label="x" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
    expect(fillOf(container)).toHaveStyle({ width: '33.333%' });
  });

  // A `0 / 0` ratio is a BROKEN measurement, not an absent one — it must not
  // collapse into the indeterminate sentinel and start pulsing.
  it.each([['NaN', NaN], ['Infinity', Infinity]])(
    'reads a non-finite %s measurement as an empty determinate bar',
    (_label, percent) => {
      const { container } = render(<ProgressBar percent={percent} label="x" />);
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
      expect(fillOf(container).className).not.toContain('animate-pulse');
    },
  );

  it.each([['null', null], ['undefined', undefined]])(
    'draws an indeterminate pulse with no aria-valuenow for a %s percentage',
    (_label, percent) => {
      const { container } = render(<ProgressBar percent={percent} label="Downloading" />);
      const bar = screen.getByRole('progressbar', { name: 'Downloading' });
      expect(bar).not.toHaveAttribute('aria-valuenow');
      // The bounds stay, so assistive tech still reads it as a 0..100 meter.
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
      const fill = fillOf(container);
      expect(fill.className).toContain('animate-pulse');
      expect(fill.getAttribute('style')).toBeFalsy();
    },
  );

  it.each([
    ['accent', 'bg-port-accent'],
    ['accent2', 'bg-port-accent-2'],
    ['success', 'bg-port-success'],
    ['warning', 'bg-port-warning'],
    ['error', 'bg-port-error'],
    ['muted', 'bg-gray-600'],
  ])('paints the %s tone', (tone, cls) => {
    const { container } = render(<ProgressBar percent={50} tone={tone} label="x" />);
    expect(fillOf(container).className).toContain(cls);
  });

  it('falls back to the accent tone for an unknown tone', () => {
    const { container } = render(<ProgressBar percent={50} tone="chartreuse" label="x" />);
    expect(fillOf(container).className).toContain('bg-port-accent');
  });

  it('switches track height and ground on size / track', () => {
    const { container } = render(<ProgressBar percent={50} size="md" track="border" label="x" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('h-2');
    expect(bar.className).toContain('bg-port-border');
    expect(container.querySelector('.h-1\\.5')).toBeNull();
  });

  it('defaults to the small size on the card ground', () => {
    render(<ProgressBar percent={50} label="x" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('h-1.5');
    expect(bar.className).toContain('bg-port-bg');
  });

  it('passes layout classes through to the track', () => {
    render(<ProgressBar percent={50} className="flex-1 mt-1.5" label="x" />);
    expect(screen.getByRole('progressbar').className).toContain('flex-1 mt-1.5');
  });

  // Tailwind can't see an interpolated `duration-${n}`, so only mapped values
  // survive the build — an unmapped one has to fall back, not emit a dead class.
  it('emits a static duration class and falls back for an unmapped one', () => {
    const { container: mapped } = render(<ProgressBar percent={50} duration={500} label="x" />);
    expect(fillOf(mapped).className).toContain('duration-500');
    const { container: unmapped } = render(<ProgressBar percent={50} duration={137} label="x" />);
    expect(fillOf(unmapped).className).toContain('duration-200');
    expect(fillOf(unmapped).className).not.toContain('duration-137');
  });
});

describe('clampPercent', () => {
  it.each([
    ['null stays indeterminate', null, null],
    ['undefined stays indeterminate', undefined, null],
    ['NaN reads as zero', NaN, 0],
    ['a non-numeric string reads as zero', 'abc', 0],
    ['a numeric string is parsed', '60', 60],
    ['over 100 clamps down', 101, 100],
    ['under 0 clamps up', -1, 0],
    ['an in-range value passes through', 12.5, 12.5],
  ])('%s', (_label, input, expected) => {
    expect(clampPercent(input)).toBe(expected);
  });
});
