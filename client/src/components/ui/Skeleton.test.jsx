import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonLines,
  SkeletonRegion,
  SkeletonRows,
  skeletonRepeat,
} from './Skeleton';

const pulses = (container) => container.querySelectorAll('.animate-pulse');

describe('skeletonRepeat', () => {
  it('produces the requested number of slots', () => {
    expect(skeletonRepeat(3)).toHaveLength(3);
  });

  // Counts come from live data, so a bad one must degrade to empty rather than
  // throwing inside `Array.from`.
  it.each([[-4], [0], [NaN], ['nope'], [undefined]])(
    'clamps %p to zero slots instead of throwing',
    (bad) => {
      expect(skeletonRepeat(bad)).toHaveLength(0);
    }
  );

  // A runaway count is capped rather than zeroed — something IS loading, so the
  // region should still reserve a plausible amount of space.
  it.each([[10_000], [Infinity]])('caps %p at the block ceiling', (huge) => {
    expect(skeletonRepeat(huge)).toHaveLength(64);
  });
});

describe('SkeletonBlock', () => {
  it('pulses but stands down for prefers-reduced-motion', () => {
    const { container } = render(<SkeletonBlock className="h-4 w-8" />);
    const block = container.firstChild;
    expect(block.className).toContain('animate-pulse');
    expect(block.className).toContain('motion-reduce:animate-none');
  });

  it('is hidden from assistive tech — the region wrapper owns the announcement', () => {
    const { container } = render(<SkeletonBlock />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('defaults to the page-background tone and swaps to the in-card tone', () => {
    const { container: onPage } = render(<SkeletonBlock />);
    expect(onPage.firstChild.className).toContain('bg-port-card');

    const { container: inCard } = render(<SkeletonBlock tone="border" />);
    expect(inCard.firstChild.className).toContain('bg-port-border');
    expect(inCard.firstChild.className).not.toContain('bg-port-card');
  });

  // Two `rounded*` utilities resolve by stylesheet order, so rounding is a prop
  // rather than something a caller layers on through className.
  it('takes rounding as a prop so it fully replaces the default', () => {
    const { container } = render(<SkeletonBlock roundedClass="rounded-full" />);
    expect(container.firstChild.className).toContain('rounded-full');
    expect(container.firstChild.className.split(/\s+/)).not.toContain('rounded');
  });

  it('applies caller sizing', () => {
    const { container } = render(<SkeletonBlock className="h-24 w-24" />);
    expect(container.firstChild.className).toContain('h-24');
    expect(container.firstChild.className).toContain('w-24');
  });
});

describe('SkeletonLines', () => {
  it('renders one line per width so ragged lengths read as prose', () => {
    const { container } = render(<SkeletonLines widths={['w-full', 'w-1/2']} />);
    expect(pulses(container)).toHaveLength(2);
    expect(container.innerHTML).toContain('w-1/2');
  });
});

describe('SkeletonCard', () => {
  it('carries real card chrome so the border does not move on swap', () => {
    const { container } = render(<SkeletonCard />);
    expect(container.firstChild.className).toContain('rounded-lg');
    expect(container.firstChild.className).toContain('border-port-border');
    expect(container.firstChild.className).toContain('bg-port-card');
  });

  it('renders a title line plus one line per body width', () => {
    const { container } = render(<SkeletonCard lineWidths={['w-1/2', 'w-1/3', 'w-1/4']} />);
    expect(pulses(container)).toHaveLength(4);
  });
});

describe('SkeletonRows', () => {
  it('renders one block per column per row so the reserved row matches the table', () => {
    const { container } = render(
      <SkeletonRows rows={3} columnWidthClasses={['flex-1', 'w-14', 'w-10']} />
    );
    expect(pulses(container)).toHaveLength(9);
  });

  it('clamps a bad row count instead of throwing', () => {
    const { container } = render(<SkeletonRows rows={-2} />);
    expect(pulses(container)).toHaveLength(0);
  });
});

describe('SkeletonRegion', () => {
  it('announces itself as a busy status region with the caller label', () => {
    render(
      <SkeletonRegion label="Loading data contents">
        <SkeletonBlock />
      </SkeletonRegion>
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('aria-label', 'Loading data contents');
  });
});
