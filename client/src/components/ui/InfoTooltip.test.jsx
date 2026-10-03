import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import InfoTooltip from './InfoTooltip';

describe('InfoTooltip', () => {
  it('exposes a focusable button trigger with an accessible label', () => {
    render(<InfoTooltip label="What does this do?">Help text</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'What does this do?' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    // Uses the ARIA tooltip pattern, not a disclosure — no aria-expanded.
    expect(btn).not.toHaveAttribute('aria-expanded');
    // Help text is hidden until revealed.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reveals the tooltip on keyboard focus and links it via aria-describedby', () => {
    render(<InfoTooltip label="help">Keyboard reachable</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.focus(btn);
    const panel = screen.getByRole('tooltip');
    expect(panel).toHaveTextContent('Keyboard reachable');
    expect(panel.className).toContain('port-opaque-surface');
    expect(btn.getAttribute('aria-describedby')).toBe(panel.getAttribute('id'));
    // Blur (tabbing away) dismisses the focus-revealed tooltip.
    fireEvent.blur(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('portals the panel outside caller clipping and keeps panel clicks and focus inside', () => {
    const { container } = render(<InfoTooltip label="help" width={320} align="start">Portal help</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.focus(btn);
    const panel = screen.getByRole('tooltip');
    expect(panel.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    expect(panel.style.width).toBe('320px');
    fireEvent.blur(btn, { relatedTarget: panel });
    fireEvent.focus(panel);
    fireEvent.mouseDown(panel);
    expect(screen.getByRole('tooltip')).toBe(panel);
    fireEvent.blur(panel);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('bridges hover to the portal with a cancellable delay, while focused help stays open', () => {
    vi.useFakeTimers();
    try {
      render(<InfoTooltip label="help">Hover bridge</InfoTooltip>);
      const btn = screen.getByRole('button', { name: 'help' });
      const wrap = btn.parentElement;
      fireEvent.mouseEnter(wrap);
      const panel = screen.getByRole('tooltip');
      fireEvent.mouseLeave(wrap);
      act(() => vi.advanceTimersByTime(100));
      fireEvent.mouseEnter(panel);
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByRole('tooltip')).toBe(panel);
      fireEvent.mouseLeave(panel);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.focus(btn);
      fireEvent.mouseEnter(wrap);
      fireEvent.mouseLeave(wrap);
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByRole('tooltip')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a 44px minimum, non-shrinking hit area on the trigger button', () => {
    render(<InfoTooltip label="help">Big target</InfoTooltip>);
    const cls = screen.getByRole('button', { name: 'help' }).className;
    expect(cls).toContain('min-h-[44px]');
    expect(cls).toContain('min-w-[44px]');
    expect(cls).toContain('shrink-0');
    expect(cls).toContain('justify-center');
  });

  it('latches open on click for touch users and survives blur', () => {
    render(<InfoTooltip label="help">Tap reachable</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tap reachable');
    // Latched open survives blur (unlike a pure hover/focus surface).
    fireEvent.blur(btn);
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('closes on a second click (toggle) without stranding the panel visible', () => {
    render(<InfoTooltip label="help">Toggles</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.focus(btn);
    fireEvent.mouseEnter(btn.parentElement);
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses the latched tooltip on Escape', () => {
    render(<InfoTooltip label="help">Dismissable</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('dismisses on an outside click', () => {
    render(
      <div>
        <InfoTooltip label="help">Outside dismiss</InfoTooltip>
        <button type="button">elsewhere</button>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'help' });
    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
