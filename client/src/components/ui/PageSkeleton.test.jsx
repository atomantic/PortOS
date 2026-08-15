import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import PageSkeleton from './PageSkeleton';

// The skeleton's whole job is to reserve dimensions, so the assertions are on
// structure + the layout classes that establish those dimensions.
const status = () => screen.getByRole('status');
const cardCount = (container) =>
  container.querySelectorAll('.rounded-lg.border.border-port-border.bg-port-card').length;

describe('PageSkeleton', () => {
  it('announces itself as a busy status region', () => {
    render(<PageSkeleton />);
    expect(status()).toHaveAttribute('aria-busy', 'true');
    expect(status()).toHaveAttribute('aria-label', 'Loading');
  });

  it('announces the caller-supplied label so the busy state names what is loading', () => {
    render(<PageSkeleton label="Loading apps" />);
    expect(status()).toHaveAttribute('aria-label', 'Loading apps');
  });

  it('passes the label through in bar-header mode too', () => {
    render(<PageSkeleton header="bar" label="Loading brain" />);
    expect(status()).toHaveAttribute('aria-label', 'Loading brain');
  });

  it('defaults to an unpadded inline header so it does not double-pad Layout main', () => {
    render(<PageSkeleton />);
    expect(status().className).not.toContain('p-4');
  });

  it('adds page padding only when padded is set', () => {
    render(<PageSkeleton padded />);
    expect(status().className).toContain('p-4');
    expect(status().className).toContain('md:p-6');
  });

  it('owns its scroll when fullHeight is set', () => {
    render(<PageSkeleton fullHeight />);
    expect(status().className).toContain('h-full');
    expect(status().className).toContain('overflow-y-auto');
  });

  it('renders the requested number of cards plus the sidebar block', () => {
    const { container } = render(<PageSkeleton cards={2} />);
    // 2 body cards + 1 sidebar card.
    expect(cardCount(container)).toBe(3);
  });

  it('drops the sidebar and its grid track when sidebar is false', () => {
    const { container } = render(<PageSkeleton cards={2} sidebar={false} />);
    expect(cardCount(container)).toBe(2);
    expect(container.innerHTML).not.toContain('lg:grid-cols-[1fr_360px]');
  });

  it('lays cards out in a responsive grid (no sidebar) for layout="grid"', () => {
    const { container } = render(
      <PageSkeleton layout="grid" cards={4} gridColsClass="grid-cols-2 sm:grid-cols-4" />
    );
    expect(cardCount(container)).toBe(4);
    expect(container.innerHTML).toContain('grid-cols-2 sm:grid-cols-4');
    expect(container.innerHTML).not.toContain('lg:grid-cols-[1fr_360px]');
  });

  it('omits the header entirely for header="none" (page already rendered its own)', () => {
    const { container } = render(<PageSkeleton header="none" cards={1} sidebar={false} />);
    // Only the single card block remains — no title/action placeholders.
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(1);
  });

  it('reserves a bordered PageHeader bar for header="bar"', () => {
    const { container } = render(<PageSkeleton header="bar" showSubtitle />);
    // PageHeader's own compact padding, mirrored so the bar height matches.
    expect(container.innerHTML).toContain('px-3 py-2 sm:px-4 sm:py-3');
    expect(container.innerHTML).toContain('border-b border-port-border');
  });

  it('lets a hand-rolled header override the bar and body padding', () => {
    const { container } = render(
      <PageSkeleton header="bar" padded barClassName="px-6 py-4 bg-port-card" bodyClassName="p-6" />
    );
    expect(container.innerHTML).toContain('px-6 py-4 bg-port-card');
    expect(container.innerHTML).toContain('p-6');
    expect(container.innerHTML).not.toContain('px-3 py-2 sm:px-4 sm:py-3');
  });

  it('omits body padding on a full-bleed tab even in bar mode', () => {
    const { container } = render(<PageSkeleton header="bar" padded={false} bodyClassName="p-4" />);
    const bodyRegion = container.querySelector('.flex-1.min-h-0');
    expect(bodyRegion.className).not.toContain('p-4');
  });

  it('reserves one strip row per tab, matching a default TabPills button box', () => {
    const { container } = render(<PageSkeleton header="bar" tabs={5} />);
    const tabRows = container.querySelectorAll('.h-\\[44px\\]');
    expect(tabRows).toHaveLength(5);
  });

  it('nests the tab strip inside the header block (undivided) for tabsInBar', () => {
    const { container } = render(<PageSkeleton header="bar" tabs={3} tabsInBar />);
    const bar = container.querySelector('.border-b.border-port-border');
    // The strip lives inside the bar, and carries no divider of its own.
    expect(bar.querySelectorAll('.h-\\[44px\\]')).toHaveLength(3);
    expect(container.querySelectorAll('.border-b.border-port-border')).toHaveLength(1);
  });

  it('keeps PageHeader subtitle-hiding by default and opts out with subtitleOnMobile', () => {
    const hidden = render(<PageSkeleton header="bar" showSubtitle />);
    expect(hidden.container.innerHTML).toContain('hidden sm:block');
    hidden.unmount();

    const shown = render(<PageSkeleton header="bar" showSubtitle subtitleOnMobile />);
    expect(shown.container.innerHTML).not.toContain('hidden sm:block');
  });

  it('defaults the header row per mode and lets a page override the break width', () => {
    const inline = render(<PageSkeleton />);
    expect(inline.container.innerHTML).toContain('flex flex-col sm:flex-row');
    inline.unmount();

    const bar = render(<PageSkeleton header="bar" />);
    expect(bar.container.innerHTML).toContain('flex flex-wrap items-center justify-between');
    bar.unmount();

    // A page whose header only stacks at `lg` must not reserve an `sm` stack.
    const override = render(<PageSkeleton headerRowClass="flex flex-col lg:flex-row gap-3" />);
    expect(override.container.innerHTML).toContain('flex flex-col lg:flex-row gap-3');
    expect(override.container.innerHTML).not.toContain('sm:flex-row');
  });

  it('renders no tab strip when tabs is 0', () => {
    const { container } = render(<PageSkeleton tabs={0} />);
    expect(container.querySelectorAll('.h-\\[44px\\]')).toHaveLength(0);
  });

  it('hides the action placeholder when showAction is false', () => {
    const { container } = render(<PageSkeleton showAction={false} cards={0} sidebar={false} />);
    // Title only — no action block.
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(1);
  });

  it('treats a negative card count as zero rather than throwing', () => {
    const { container } = render(<PageSkeleton cards={-3} sidebar={false} />);
    expect(cardCount(container)).toBe(0);
  });

  it('clamps a negative or fractional tab count instead of throwing on Array.from', () => {
    const negative = render(<PageSkeleton header="bar" tabs={-2} />);
    expect(negative.container.querySelectorAll('.h-\\[44px\\]')).toHaveLength(0);
    negative.unmount();

    const fractional = render(<PageSkeleton header="bar" tabs={3.7} />);
    expect(fractional.container.querySelectorAll('.h-\\[44px\\]')).toHaveLength(3);
    fractional.unmount();

    // Infinity would also throw RangeError without the upper clamp.
    const infinite = render(<PageSkeleton cards={Infinity} sidebar={false} />);
    expect(cardCount(infinite.container)).toBe(64);
  });

  describe('layout="split"', () => {
    const sideBlocks = (container) => container.querySelectorAll('.h-\\[52px\\]');

    it('reserves the two-pane grid tracks and drops the stack sidebar', () => {
      const { container } = render(<PageSkeleton layout="split" cards={2} />);
      expect(status().className).toContain('lg:grid');
      expect(status().className).toContain('lg:grid-cols-[320px_1fr]');
      // The stack layout's right sidebar must not sneak into the main pane.
      expect(container.innerHTML).not.toContain('lg:grid-cols-[1fr_360px]');
      expect(cardCount(container)).toBe(2);
    });

    it('takes the caller grid tracks so a collapsed rail reserves its real width', () => {
      render(<PageSkeleton layout="split" splitColsClass="lg:grid-cols-[0px_1fr]" />);
      expect(status().className).toContain('lg:grid-cols-[0px_1fr]');
    });

    it('renders the tab strip INSIDE the main pane, not above the split', () => {
      const { container } = render(<PageSkeleton layout="split" tabs={3} sideBlocks={0} />);
      const strip = container.querySelector('.h-\\[44px\\]').closest('.flex-1');
      // The strip's pane is the main pane — the one holding the cards.
      expect(strip).not.toBeNull();
      expect(strip.querySelectorAll('.rounded-lg.border.border-port-border.bg-port-card').length)
        .toBeGreaterThan(0);
    });

    it('reserves the hero block and the rail blocks in the requested column count', () => {
      const { container } = render(
        <PageSkeleton layout="split" sideHero sideBlocks={4} sideBlockColsClass="grid-cols-2" />
      );
      expect(container.querySelector('.rounded-full')).not.toBeNull();
      expect(sideBlocks(container)).toHaveLength(4);
      expect(container.innerHTML).toContain('grid gap-1.5 grid-cols-2');
    });

    it('omits the hero and the rail blocks when they are not requested', () => {
      const { container } = render(<PageSkeleton layout="split" sideHero={false} sideBlocks={0} />);
      expect(container.querySelector('.rounded-full')).toBeNull();
      expect(sideBlocks(container)).toHaveLength(0);
    });

    it('keeps a zero-width desktop track plus the mobile band when sideCollapsed', () => {
      const { container } = render(<PageSkeleton layout="split" sideCollapsed sideBlocks={2} />);
      // The empty desktop track keeps the main pane in grid column 2.
      expect(container.querySelector('.hidden.lg\\:block')).not.toBeNull();
      // The rail itself only survives below `lg`, where the page stacks.
      const rail = sideBlocks(container)[0].closest('.lg\\:hidden');
      expect(rail).not.toBeNull();
    });

    it('owns the full height only when fullHeight is set', () => {
      const tall = render(<PageSkeleton layout="split" fullHeight />);
      expect(status().className).toContain('h-full');
      tall.unmount();

      render(<PageSkeleton layout="split" />);
      expect(status().className).not.toContain('h-full');
    });

    it('pads the main pane with bodyClassName only when padded', () => {
      const { container } = render(
        <PageSkeleton layout="split" padded bodyClassName="p-3 lg:p-4" sideBlocks={0} />
      );
      expect(container.querySelector('.flex-1').className).toContain('p-3 lg:p-4');
    });
  });
});
