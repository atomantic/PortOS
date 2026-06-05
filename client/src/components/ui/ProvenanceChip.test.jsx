import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ProvenanceChip from './ProvenanceChip';
import { PROVENANCE_LEVELS } from '../../lib/healthProvenance.js';

describe('ProvenanceChip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the level label and the success tone for data-backed', () => {
    render(<ProvenanceChip level="data-backed" />);
    const btn = screen.getByRole('button', { name: /data-backed/i });
    expect(btn.className).toContain('text-port-success');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('falls back to the inferred level for an unknown id', () => {
    render(<ProvenanceChip level="bogus" />);
    expect(screen.getByRole('button', { name: /inferred/i })).toBeTruthy();
  });

  it('reveals the default explainer and "what would change this?" on click', () => {
    render(<ProvenanceChip level="speculative" />);
    const btn = screen.getByRole('button');
    expect(screen.queryByText('What would change this?')).toBeNull();

    fireEvent.click(btn);

    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('What would change this?')).toBeTruthy();
    expect(screen.getByText(PROVENANCE_LEVELS.speculative.description)).toBeTruthy();
    expect(screen.getByText(PROVENANCE_LEVELS.speculative.whatWouldChange)).toBeTruthy();
  });

  it('prefers custom explainer / whatWouldChange copy over the level defaults', () => {
    render(
      <ProvenanceChip
        level="inferred"
        explainer="Custom how-derived copy."
        whatWouldChange="Custom change copy."
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Custom how-derived copy.')).toBeTruthy();
    expect(screen.getByText('Custom change copy.')).toBeTruthy();
    expect(screen.queryByText(PROVENANCE_LEVELS.inferred.description)).toBeNull();
  });

  it('overrides the chip label when label prop is set, keeping the resolved tone', () => {
    render(<ProvenanceChip level="experimental" label="Beta clock" />);
    const btn = screen.getByRole('button', { name: /beta clock/i });
    expect(btn.className).toContain('text-port-warning');
  });

  it('closes the popover on a click outside', () => {
    render(
      <div>
        <ProvenanceChip level="inferred" />
        <button type="button">elsewhere</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /inferred/i }));
    expect(screen.getByText('What would change this?')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByText('What would change this?')).toBeNull();
  });

  it('closes the popover on Escape', () => {
    render(<ProvenanceChip level="inferred" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(screen.getByText('What would change this?')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('What would change this?')).toBeNull();
  });

  // Position the chip at a known viewport rect so the fixed-popover math is
  // deterministic (jsdom's getBoundingClientRect is all-zero otherwise).
  const stubChipRect = (rect) => {
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      ...rect, toJSON: () => {},
    });
  };

  // jsdom reports offsetHeight as 0; stub it so the below/above flip is testable.
  const stubPopHeight = (h) => {
    vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(h);
  };

  const openPopover = (props = {}) => {
    render(<ProvenanceChip level="inferred" {...props} />);
    fireEvent.click(screen.getByRole('button'));
    return screen.getByText('What would change this?').closest('div');
  };

  it('renders the popover as a fixed, viewport-escaping layer', () => {
    stubChipRect({ left: 500, right: 560, top: 20, bottom: 40 });
    const popover = openPopover();
    // Fixed (not absolute) is what lets the panel escape an overflow-hidden
    // dashboard cell instead of clipping inside it.
    expect(popover.style.position).toBe('fixed');
    expect(popover.style.top).toBe('46px'); // bottom (40) + 6px gap
  });

  it('biases the popover under the chip\'s left edge for align="start" and right edge for align="end"', () => {
    stubChipRect({ left: 500, right: 560, top: 20, bottom: 40 }); // innerWidth 1024 in jsdom
    const { unmount } = render(<ProvenanceChip level="inferred" />);
    fireEvent.click(screen.getByRole('button'));
    // start → popover left edge sits at the chip's left (500).
    expect(screen.getByText('What would change this?').closest('div').style.left).toBe('500px');
    unmount();

    render(<ProvenanceChip level="inferred" align="end" />);
    fireEvent.click(screen.getByRole('button'));
    // end → popover right edge sits at the chip's right (560): 560 - 256 = 304.
    expect(screen.getByText('What would change this?').closest('div').style.left).toBe('304px');
  });

  it('clamps the popover into the viewport when the chip is near the right edge', () => {
    // A chip in a narrow widget near the right edge would push a 256px panel
    // off-screen; the clamp pulls it back to (innerWidth - width - margin).
    stubChipRect({ left: 1000, right: 1020, top: 20, bottom: 40 }); // innerWidth 1024
    const popover = openPopover();
    // 1024 - 256 - 8 = 760.
    expect(popover.style.left).toBe('760px');
  });

  it('flips the popover above the chip when there is no room below', () => {
    // jsdom viewport height is 768. A chip near the bottom with a 120px popover
    // can't open below (740 + 6 + 120 > 768 - 8), so it flips above the chip:
    // top - gap - height = 730 - 6 - 120 = 604.
    stubPopHeight(120);
    stubChipRect({ left: 500, right: 560, top: 730, bottom: 750 });
    const popover = openPopover();
    expect(popover.style.top).toBe('604px');
  });

  it('opens below the chip when there is room', () => {
    // Same 120px popover, but the chip is high up: 40 + 6 + 120 fits in 768, so
    // it stays below at bottom + gap = 46.
    stubPopHeight(120);
    stubChipRect({ left: 500, right: 560, top: 20, bottom: 40 });
    const popover = openPopover();
    expect(popover.style.top).toBe('46px');
  });

  it('constrains width via className (not inline) so hidden and visible passes wrap identically', () => {
    // The height that drives the below/above flip is measured during the hidden
    // pass; if width were applied only to the visible style, the hidden pass would
    // wrap at full width and under-measure. Pin width to the className instead.
    stubChipRect({ left: 500, right: 560, top: 20, bottom: 40 });
    const popover = openPopover();
    expect(popover.className).toContain('w-64');
    expect(popover.style.width).toBe(''); // width is NOT set inline
  });
});
