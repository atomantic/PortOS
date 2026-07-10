import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import InfoTooltip from './InfoTooltip';

describe('InfoTooltip', () => {
  it('exposes a focusable button trigger with an accessible label', () => {
    render(<InfoTooltip label="What does this do?">Help text</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'What does this do?' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    // Help text is hidden until revealed.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reveals the tooltip on keyboard focus and links it via aria-describedby', () => {
    render(<InfoTooltip label="help">Keyboard reachable</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.focus(btn);
    const panel = screen.getByRole('tooltip');
    expect(panel).toHaveTextContent('Keyboard reachable');
    expect(btn.getAttribute('aria-describedby')).toBe(panel.getAttribute('id'));
  });

  it('toggles (latches) open on click for touch users and reflects aria-expanded', () => {
    render(<InfoTooltip label="help">Tap reachable</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Tap reachable');
    // Latched open survives blur (unlike a pure hover surface).
    fireEvent.blur(btn);
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('dismisses the latched tooltip on Escape', () => {
    render(<InfoTooltip label="help">Dismissable</InfoTooltip>);
    const btn = screen.getByRole('button', { name: 'help' });
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});
